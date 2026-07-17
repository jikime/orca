import type { Kysely, Transaction } from 'kysely'
import { ensurePendingIntakeTx } from './agent-session-intake-store'
import {
  emitAgentExecutionChange,
  loadAgentSessionTx,
  type AgentSession
} from './agent-session-store'
import type { Database } from './database-schema'
import { projectTurnFromEvent } from './agent-turn-projection'
import {
  isProvenanceType,
  parseProvenancePayload,
  projectProvenanceFromEvent,
  provenanceKindOfType,
  resolveProvenanceTrustDomain,
  type ProvenancePayload
} from './agent-provenance-projection'
import { normalizeVisibility } from './agent-visibility-scope'
import { scanForSecrets, type SecretScanResult } from './agent-content-secret-scan'
import type { SignedExecutionContext } from './execution-context-canonical'
import {
  applySessionBindingTx,
  verifyExecutionContextTx,
  type ExecutionContextRejectionCode
} from './execution-context-verification'
import { consumeBatchSubmissionNonceTx } from './batch-submission-nonce-store'
import {
  fingerprintPayload,
  quarantineEventTx,
  type QuarantineReasonCode
} from './agent-event-quarantine-store'
import { withTenantTransaction } from './tenant-transaction'

// OPS-001: a per-event body over this cap is treated as poison — rejected + quarantined (metadata
// only) so it can never bloat the append-only log or block its valid batch siblings. The envelope
// contract already bounds property COUNT (maxProperties); this bounds serialized BYTE size.
const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024

// The rejection `code` returned per-item, mapped to the durable quarantine reason_code.
const QUARANTINE_REASON_BY_CODE: Record<string, QuarantineReasonCode> = {
  ORG_MISMATCH: 'org_mismatch',
  SESSION_NOT_FOUND: 'session_not_found',
  SESSION_CLOSED: 'session_closed',
  PRODUCER_MISMATCH: 'producer_mismatch',
  PROVENANCE_INVALID: 'provenance_invalid',
  PAYLOAD_OVERSIZED: 'oversized'
}

// The body a would-be stored/scanned event carries (payloadObject wins when present, else payload).
function eventBody(event: AgentEventEnvelope): Record<string, unknown> {
  return event.data.payloadObject !== undefined
    ? event.data.payloadObject
    : (event.data.payload ?? {})
}

// R5 slice 1: Control-Plane agent-event ingest (doc 19 :203-236, doc 20 CAP-001..008).
// The ingest is idempotent per (org, eventId), append-only, and binds each event's producer
// to a session that exists in THIS org (a batch cannot forge another org/session). It stamps
// received_at server-side and reports per-stream sequence gaps — it never fabricates a
// cross-host global order from client time.

// The validated CloudEvents agent-event envelope (agent-event-envelope.v1.schema.json). The
// route validates the batch against the contract before calling, so this shape is trusted.
export type AgentEventEnvelope = {
  id: string
  source: string
  type: string
  subject: string
  time: string
  pieorgid: string
  piestream: string
  piesequence: number
  data: {
    context: {
      projectId: string | null
      workItemId: string | null
      workspaceId: string | null
      hostId: string
      launchId: string | null
      agentSessionId: string
      agentRunId: string | null
      turnId: string | null
    }
    producer: {
      type: 'hook' | 'transcript_reconciler' | 'runtime_observer' | 'mcp'
      provider: string
      parserVersion: string
      trustDomain: 'client_observed' | 'provider_asserted' | 'server_verified'
    }
    assertion: 'observed' | 'declared' | 'verified'
    classification: string
    visibility: string
    payload?: Record<string, unknown>
    payloadObject?: Record<string, unknown>
    correlationId?: string | null
    causationId?: string | null
    capturedAt: string
  }
}

export type IngestAgentEventsInput = {
  organizationId: string
  batchId: string
  producerId: string
  // The authenticated principal recorded as the audit actor for projected provenance.
  actorId?: string | null
  // R5 s2b: the Pie user id that owns the installation key, used to verify a signed context.
  actorUserId?: string
  // R5 s2b: the optional signed ExecutionContext that binds this batch to one signed session.
  executionContext?: SignedExecutionContext
  // R5 s5: the optional per-batch one-time-use nonce (anti-replay); enforced only with a context.
  submissionNonce?: string
  // R5 s2b: server receive time (injected for determinism); defaults to now().
  receivedAt?: Date
  clientCheckpoint: { streamId: string; lastServerAck: number }
  events: AgentEventEnvelope[]
}

export type AgentEventItemStatus =
  | 'accepted'
  | 'duplicate'
  | 'retryable_rejected'
  | 'permanent_rejected'
export type AgentEventResult = {
  id: string
  status: AgentEventItemStatus
  code?: string
  retryAfterMs?: number
}
// Per-stream gap report (doc 19: sequence is for gap detection, NOT global ordering).
export type AgentStreamAck = { streamId: string; contiguousThrough: number; gaps: number[] }
export type IngestAgentEventsResult = {
  batchId: string
  results: AgentEventResult[]
  streamAcks: AgentStreamAck[]
  // R5 s2b: present only when a signed ExecutionContext was rejected — the whole batch is refused
  // (no events ingested) and the route maps this to a 422 problem.
  contextRejection?: { code: ExecutionContextRejectionCode }
}

// A content hash carried in the event payload is what confirms a turn's finalization.
function contentHashOf(event: AgentEventEnvelope): string | null {
  const raw = event.data.payload?.contentHash
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

// Bind the producer to the session (anti-forgery, pre-crypto). The event's declared provider
// must match the session's provider; a mismatch is a permanent rejection. TODO(pie-r5): s2/s3
// replace this identity check with a verified ExecutionContext + SessionBinding signature.
function rejectionCode(event: AgentEventEnvelope, session: AgentSession | null): string | null {
  if (session === null) {
    return 'SESSION_NOT_FOUND'
  }
  if (session.status !== 'active') {
    return 'SESSION_CLOSED'
  }
  if (event.data.producer.provider !== session.provider) {
    return 'PRODUCER_MISMATCH'
  }
  return null
}

// SEC-003 content-floor-over-label: the payload body a `full`-capture event will store, scanned for
// a secret regardless of the client's declared classification. Returns null when the body is
// stripped (metadata_only) — no content is stored, so there is nothing to floor or leak.
function scanEventPayload(event: AgentEventEnvelope): SecretScanResult {
  return scanForSecrets(JSON.stringify(eventBody(event)))
}

// never-log-the-secret: the audit fact carries only the detected KINDS and a COUNT, never any
// matched secret text, so the audit stream can prove detection without re-leaking the secret.
async function auditSecretDetected(
  trx: Transaction<Database>,
  organizationId: string,
  actorId: string | null,
  eventId: string,
  scan: SecretScanResult
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorId,
      action: 'agent_event.secret_detected',
      target_type: 'agent_event',
      target_id: eventId,
      after_digest: `${scan.kinds.join('+')}:${scan.count}`
    })
    .execute()
}

async function insertEventTx(
  trx: Transaction<Database>,
  organizationId: string,
  producerId: string,
  event: AgentEventEnvelope,
  contentHash: string | null,
  stripPayload: boolean,
  effectiveClassification: string
): Promise<boolean> {
  const carriesObject = event.data.payloadObject !== undefined
  // capture_mode='metadata_only' drops the payload BODY but keeps the envelope metadata (type,
  // classification, visibility, sequence, content_hash). The XOR payload-present CHECK still needs
  // exactly one carrier, so the stripped payload is an empty object, never the raw content.
  const payload = stripPayload
    ? JSON.stringify({})
    : carriesObject
      ? null
      : JSON.stringify(event.data.payload ?? {})
  const payloadObject = stripPayload
    ? null
    : carriesObject
      ? JSON.stringify(event.data.payloadObject)
      : null
  // ON CONFLICT (org, event_id) DO NOTHING → a replayed eventId is a no-op (idempotency).
  const inserted = await trx
    .insertInto('execution.agent_events')
    .values({
      organization_id: organizationId,
      event_id: event.id,
      agent_session_id: event.data.context.agentSessionId,
      stream_id: event.piestream,
      sequence: event.piesequence,
      type: event.type,
      source_uri: event.source,
      subject: event.subject,
      producer_id: producerId,
      producer_type: event.data.producer.type,
      provider: event.data.producer.provider,
      parser_version: event.data.producer.parserVersion,
      trust_domain: event.data.producer.trustDomain,
      assertion: event.data.assertion,
      // SEC-003: the stored classification is the content-floored one (raised to `restricted` when
      // the body contains a secret) — never the raw client label — so all downstream scope/
      // redaction treats a mislabeled secret correctly. The raw payload bytes are still stored
      // (append-only; evidence is not silently mutated), protected by RLS/scope + read redaction.
      classification: effectiveClassification,
      visibility: event.data.visibility,
      agent_run_id: event.data.context.agentRunId,
      turn_id: event.data.context.turnId,
      occurred_at: event.time,
      captured_at: event.data.capturedAt,
      // received_at is server-stamped by the column default now() — never client time.
      content_hash: contentHash,
      payload,
      payload_object: payloadObject,
      correlation_id: event.data.correlationId ?? null,
      causation_id: event.data.causationId ?? null
    })
    .onConflict((oc) => oc.columns(['organization_id', 'event_id']).doNothing())
    .returning('id')
    .executeTakeFirst()
  return inserted !== undefined
}

// capture_mode='paused' drops the event but records an append-only gap tombstone so the paused
// window is an EXPLICIT gap on the timeline, not a silent loss (paused-gap-not-silent-loss).
// Idempotent on (org, event_id): a replayed paused event re-marks the same gap, never a second.
// Default-deny: an unrecognized visibility is stored as the most restrictive `internal`.
async function insertCaptureGapTx(
  trx: Transaction<Database>,
  organizationId: string,
  event: AgentEventEnvelope
): Promise<boolean> {
  const inserted = await trx
    .insertInto('execution.agent_capture_gaps')
    .values({
      organization_id: organizationId,
      event_id: event.id,
      agent_session_id: event.data.context.agentSessionId,
      stream_id: event.piestream,
      sequence: event.piesequence,
      turn_id: event.data.context.turnId,
      visibility: normalizeVisibility(event.data.visibility),
      reason: 'capture_paused',
      occurred_at: event.time,
      captured_at: event.data.capturedAt
    })
    .onConflict((oc) => oc.columns(['organization_id', 'event_id']).doNothing())
    .returning('id')
    .executeTakeFirst()
  return inserted !== undefined
}

// Contiguous-through + gaps for one stream, computed from the persisted sequences (doc 19:
// order within a stream by sequence). contiguousThrough is the largest N with every sequence
// in 1..N present; gaps are the missing sequences below the max seen.
async function streamAckTx(
  trx: Transaction<Database>,
  agentSessionId: string,
  streamId: string
): Promise<AgentStreamAck> {
  const rows = await trx
    .selectFrom('execution.agent_events')
    .select('sequence')
    .where('agent_session_id', '=', agentSessionId)
    .where('stream_id', '=', streamId)
    .execute()
  const present = new Set(rows.map((row) => Number(row.sequence)))
  if (present.size === 0) {
    return { streamId, contiguousThrough: 0, gaps: [] }
  }
  const maxSeq = Math.max(...present)
  let contiguousThrough = 0
  while (present.has(contiguousThrough + 1)) {
    contiguousThrough += 1
  }
  const gaps: number[] = []
  for (let seq = 1; seq <= maxSeq; seq += 1) {
    if (!present.has(seq)) {
      gaps.push(seq)
    }
  }
  return { streamId, contiguousThrough, gaps }
}

// A provenance-typed event carries a structured provenance payload; the kind comes from the
// event `type` (authoritative). Returns the validated payload, or null if the payload is
// malformed (the caller rejects such an event rather than storing partial evidence).
function validatedProvenance(
  event: AgentEventEnvelope
): { kind: ReturnType<typeof provenanceKindOfType>; payload: ProvenancePayload } | null {
  const kind = provenanceKindOfType(event.type)
  if (kind === null) {
    return null
  }
  const payload = parseProvenancePayload(kind, event.data.payload)
  return payload ? { kind, payload } : null
}

// Projects one accepted provenance event and audits it. A revision > 1 means the event
// corrected/reclassified prior evidence — audited distinctly so a reclassification is traceable.
async function projectAndAuditProvenance(
  trx: Transaction<Database>,
  organizationId: string,
  actorId: string | null,
  event: AgentEventEnvelope,
  kind: NonNullable<ReturnType<typeof provenanceKindOfType>>,
  payload: ProvenancePayload
): Promise<{ id: string; revision: number } | null> {
  const trustDomain = resolveProvenanceTrustDomain(
    event.data.assertion,
    event.data.producer.trustDomain
  )
  const projected = await projectProvenanceFromEvent(
    trx,
    organizationId,
    event.data.context.agentSessionId,
    {
      sourceEventId: event.id,
      agentRunId: event.data.context.agentRunId,
      kind,
      trustDomain,
      occurredAt: event.time,
      payload
    }
  )
  if (!projected) {
    return null
  }
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorId,
      action: projected.revision > 1 ? 'provenance.reclassified' : 'provenance.ingested',
      target_type: 'agent_provenance',
      target_id: projected.id,
      // The trust domain is the audit-relevant fact: was this evidence or a declared claim.
      after_digest: `${kind}:${trustDomain}`
    })
    .execute()
  return projected
}

// Records one signed-context audit fact (rejected or verified) on the bound session's timeline.
async function auditExecutionContext(
  trx: Transaction<Database>,
  organizationId: string,
  actorId: string | null,
  agentSessionId: string,
  action: 'execution_context.rejected' | 'execution_context.verified',
  digest: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorId,
      action,
      target_type: 'agent_session',
      target_id: agentSessionId,
      after_digest: digest
    })
    .execute()
}

/**
 * R5 s2b: verifies the signed ExecutionContext and records the SessionBinding BEFORE the per-event
 * loop. The context names exactly one agentSessionId, so the binding is applied to that one session
 * (if it exists). Returns a rejection code (batch refused) or null (proceed). Every outcome writes
 * an audit fact; a rejection commits only that audit row, no events.
 */
async function verifyAndBindContext(
  trx: Transaction<Database>,
  input: IngestAgentEventsInput,
  signed: SignedExecutionContext,
  receivedAt: Date
): Promise<ExecutionContextRejectionCode | null> {
  const actorId = input.actorUserId ?? input.actorId ?? null
  const agentSessionIds = [...new Set(input.events.map((e) => e.data.context.agentSessionId))]
  const verified = await verifyExecutionContextTx(trx, {
    actorUserId: input.actorUserId ?? '',
    receivedAtMs: receivedAt.getTime(),
    agentSessionIds,
    signed
  })
  const boundSessionId = signed.context.agentSessionId
  if (!verified.ok) {
    await auditExecutionContext(
      trx,
      input.organizationId,
      actorId,
      boundSessionId,
      'execution_context.rejected',
      verified.code
    )
    return verified.code
  }
  // one-time-use: the context is authentic and in-window, so record the BATCH nonce (anti-replay).
  // A consumed (installation, nonce) re-presented under a DIFFERENT batchId is a replay; the SAME
  // batchId is a legit retry that proceeds (event idempotency dedups its events). The nonce rides
  // the batch, not the signed context, so the canonical signed form is unchanged.
  if (input.submissionNonce) {
    const nonceOutcome = await consumeBatchSubmissionNonceTx(trx, {
      organizationId: input.organizationId,
      installationId: verified.binding.installationId,
      submissionNonce: input.submissionNonce,
      batchId: input.batchId,
      notAfter: verified.binding.notAfter,
      nowMs: receivedAt.getTime()
    })
    if (nonceOutcome === 'replayed') {
      await auditExecutionContext(
        trx,
        input.organizationId,
        actorId,
        boundSessionId,
        'execution_context.rejected',
        'SUBMISSION_REPLAYED'
      )
      return 'SUBMISSION_REPLAYED'
    }
  }
  // A present context names one session; bind it now (a missing session is fine — the per-event
  // loop rejects its events, and a re-bind to a different host identity is BINDING_HOST_MISMATCH).
  const applied = await applySessionBindingTx(
    trx,
    input.organizationId,
    boundSessionId,
    verified.binding
  )
  if (applied.conflict) {
    await auditExecutionContext(
      trx,
      input.organizationId,
      actorId,
      boundSessionId,
      'execution_context.rejected',
      'BINDING_HOST_MISMATCH'
    )
    return 'BINDING_HOST_MISMATCH'
  }
  await auditExecutionContext(
    trx,
    input.organizationId,
    actorId,
    boundSessionId,
    'execution_context.verified',
    `installation_signed:${verified.binding.publicKeyId}`
  )
  return null
}

/**
 * Ingests a validated batch in ONE tenant tx. Each event is idempotent by (org, eventId): a
 * replay is a `duplicate` no-op that creates neither a second event nor a second turn. Events
 * that target another org, a missing/closed session, or a mismatched producer are rejected
 * (the valid siblings still commit). Accepted events fold into their turn (provisional →
 * immutable on a confirmed content hash). Emits an agent_event invalidation per touched
 * session (version bump) and an agent_turn invalidation per finalized turn. Returns per-item
 * statuses and per-stream gap acks.
 */
export async function ingestAgentEvents(
  db: Kysely<Database>,
  input: IngestAgentEventsInput
): Promise<IngestAgentEventsResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    // R5 s2b: a signed ExecutionContext is verified + bound BEFORE any event is ingested. A
    // rejection refuses the whole batch (only the audit row commits); a batch without a context
    // ingests exactly as R5 s1 (local_observed).
    if (input.executionContext) {
      const rejection = await verifyAndBindContext(
        trx,
        input,
        input.executionContext,
        input.receivedAt ?? new Date()
      )
      if (rejection !== null) {
        // The tx commits only the audit row; no events ingested.
        return {
          batchId: input.batchId,
          results: [],
          streamAcks: [],
          contextRejection: { code: rejection }
        }
      }
    }

    const sessions = new Map<string, AgentSession | null>()
    const loadSession = async (sessionId: string): Promise<AgentSession | null> => {
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, await loadAgentSessionTx(trx, sessionId))
      }
      return sessions.get(sessionId) ?? null
    }

    const results: AgentEventResult[] = []
    // progress-around-poison: a per-item rejection records the result AND parks the poison in the
    // quarantine (best-effort), then the loop CONTINUES so the batch's valid siblings still commit.
    const rejectPermanently = async (
      event: AgentEventEnvelope,
      code: string,
      reasonCode: QuarantineReasonCode
    ): Promise<void> => {
      const { contentHash, payloadSizeBytes } = fingerprintPayload(eventBody(event))
      await quarantineEventTx(trx, input.organizationId, input.actorId ?? null, {
        eventId: event.id,
        agentSessionId: event.data.context.agentSessionId,
        streamId: event.piestream,
        sequence: event.piesequence,
        reasonCode,
        contentHash,
        payloadSizeBytes
      })
      results.push({ id: event.id, status: 'permanent_rejected', code })
    }
    const touchedSessions = new Set<string>()
    const finalizedTurns = new Set<string>()
    const projectedProvenance: { id: string; revision: number }[] = []
    const touchedStreams = new Map<string, string>() // streamId → agentSessionId
    // Capture scope for a would-be intake row: the workspace an accepted event names for its
    // session (host/provider come from the session itself).
    const sessionWorkspace = new Map<string, string | null>()

    for (const event of input.events) {
      // Anti-forgery: a batch cannot smuggle an event for another org (doc 19 :227-228).
      if (event.pieorgid !== input.organizationId) {
        await rejectPermanently(event, 'ORG_MISMATCH', 'org_mismatch')
        continue
      }
      const session = await loadSession(event.data.context.agentSessionId)
      const code = rejectionCode(event, session)
      if (code !== null || session === null) {
        const rejectionReason = code ?? 'SESSION_NOT_FOUND'
        await rejectPermanently(
          event,
          rejectionReason,
          QUARANTINE_REASON_BY_CODE[rejectionReason] ?? 'session_not_found'
        )
        continue
      }
      // OPS-001: an over-cap body is poison — reject + quarantine (metadata only) before it can be
      // stored or projected, so the valid siblings still commit around it.
      if (Buffer.byteLength(JSON.stringify(eventBody(event)), 'utf-8') > MAX_EVENT_PAYLOAD_BYTES) {
        await rejectPermanently(event, 'PAYLOAD_OVERSIZED', 'oversized')
        continue
      }
      // A provenance-typed event must carry a well-formed provenance payload; a malformed one
      // is rejected rather than stored as partial evidence.
      let provenance: ReturnType<typeof validatedProvenance> = null
      if (isProvenanceType(event.type)) {
        provenance = validatedProvenance(event)
        if (provenance === null) {
          await rejectPermanently(event, 'PROVENANCE_INVALID', 'provenance_invalid')
          continue
        }
      }
      const contentHash = contentHashOf(event)
      // capture_mode gates ingest: paused writes only a gap tombstone (no event, no turn, no
      // provenance); metadata_only strips the payload body before insert; full stores everything.
      if (session.captureMode === 'paused') {
        const marked = await insertCaptureGapTx(trx, input.organizationId, event)
        if (!marked) {
          results.push({ id: event.id, status: 'duplicate' })
          continue
        }
        // Touch the session/stream so the timeline (now showing the gap) re-reads and the stream
        // ack reflects the intentional sequence gap rather than a lost event.
        touchedSessions.add(session.id)
        touchedStreams.set(event.piestream, session.id)
        if (!sessionWorkspace.has(session.id)) {
          sessionWorkspace.set(session.id, event.data.context.workspaceId)
        }
        results.push({ id: event.id, status: 'accepted' })
        continue
      }
      const stripPayload = session.captureMode === 'metadata_only'
      // SEC-003: content-floor-over-label. A secret in the body raises the stored classification to
      // `restricted` no matter what label the client declared. metadata_only stores no body, so
      // there is nothing to scan or floor.
      const secretScan = stripPayload ? null : scanEventPayload(event)
      const effectiveClassification = secretScan?.hasSecret
        ? 'restricted'
        : event.data.classification
      const inserted = await insertEventTx(
        trx,
        input.organizationId,
        input.producerId,
        event,
        contentHash,
        stripPayload,
        effectiveClassification
      )
      if (!inserted) {
        // Same eventId already stored → idempotent no-op (no duplicate event, turn, or provenance).
        results.push({ id: event.id, status: 'duplicate' })
        continue
      }
      if (secretScan?.hasSecret) {
        // Metadata-only audit fact (kind + count); the secret text is never recorded.
        await auditSecretDetected(
          trx,
          input.organizationId,
          input.actorId ?? null,
          event.id,
          secretScan
        )
      }
      touchedSessions.add(session.id)
      touchedStreams.set(event.piestream, session.id)
      if (!sessionWorkspace.has(session.id)) {
        sessionWorkspace.set(session.id, event.data.context.workspaceId)
      }
      const projection = await projectTurnFromEvent(trx, input.organizationId, session.id, {
        turnId: event.data.context.turnId,
        streamId: event.piestream,
        sequence: event.piesequence,
        occurredAt: event.time,
        assertion: event.data.assertion,
        contentHash
      })
      if (projection.finalized && event.data.context.turnId !== null) {
        finalizedTurns.add(event.data.context.turnId)
      }
      if (provenance !== null && provenance.kind !== null) {
        const projected = await projectAndAuditProvenance(
          trx,
          input.organizationId,
          input.actorId ?? null,
          event,
          provenance.kind,
          provenance.payload
        )
        if (projected) {
          projectedProvenance.push(projected)
        }
      }
      results.push({ id: event.id, status: 'accepted' })
    }

    for (const sessionId of touchedSessions) {
      const session = sessions.get(sessionId)
      if (session) {
        const nextVersion = session.version + 1
        await trx
          .updateTable('execution.agent_sessions')
          .set({ version: nextVersion, updated_at: new Date() })
          .where('id', '=', sessionId)
          .execute()
        await emitAgentExecutionChange(
          trx,
          input.organizationId,
          'agent_event',
          sessionId,
          nextVersion,
          'updated'
        )
        // CAP-001: an event ingested for a session with NO work_item ensures a pending intake row
        // (idempotent — replays never duplicate it). The session is NOT auto-bound to a project;
        // only an explicit assign sets its work_item_id.
        if (session.workItemId === null) {
          await ensurePendingIntakeTx(trx, input.organizationId, {
            agentSessionId: sessionId,
            hostId: session.hostId,
            provider: session.provider,
            workspaceId: sessionWorkspace.get(sessionId) ?? null,
            detectedReason: 'no_work_item'
          })
        }
      }
    }
    for (const turnId of finalizedTurns) {
      await emitAgentExecutionChange(trx, input.organizationId, 'agent_turn', turnId, 1, 'updated')
    }
    for (const provenance of projectedProvenance) {
      // A revision > 1 is a correction of prior evidence (updated); a fresh chain is created.
      await emitAgentExecutionChange(
        trx,
        input.organizationId,
        'agent_provenance',
        provenance.id,
        provenance.revision,
        provenance.revision > 1 ? 'updated' : 'created'
      )
    }

    // Report an ack for every stream touched this batch plus the client's checkpoint stream.
    const streamIds = new Map(touchedStreams)
    if (!streamIds.has(input.clientCheckpoint.streamId)) {
      // The checkpoint stream may have no accepted events this batch (all duplicates); still ack
      // it against whichever session already owns it, if any.
      const owner = await trx
        .selectFrom('execution.agent_events')
        .select('agent_session_id')
        .where('stream_id', '=', input.clientCheckpoint.streamId)
        .executeTakeFirst()
      if (owner) {
        streamIds.set(input.clientCheckpoint.streamId, owner.agent_session_id)
      }
    }
    const streamAcks: AgentStreamAck[] = []
    for (const [streamId, sessionId] of streamIds) {
      streamAcks.push(await streamAckTx(trx, sessionId, streamId))
    }

    return { batchId: input.batchId, results, streamAcks }
  })
}
