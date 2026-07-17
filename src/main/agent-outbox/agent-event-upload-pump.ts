import type {
  AgentEventBatchRequest,
  AgentEventBatchResponse
} from '../../shared/agent-event-batch-contract'
import { AGENT_EVENT_PROTOCOL_VERSION } from '../../shared/agent-event-batch-contract'
import type { SignedExecutionContext } from '../../shared/execution-context-contract'
import { AgentEventUploadError, type AgentEventUploadClient } from './agent-event-upload-client'
import { resolveSubmissionNonce, type SubmissionNonceCache } from './agent-batch-submission-nonce'
import type {
  AgentEventOutboxStore,
  ClaimedOutboxItem,
  OutboxAuditRecord
} from './agent-event-outbox-store'

// The reliable upload pump (R5 s2). Under the store's SINGLE-WRITER invariant, exactly one pump
// claims a batch, re-checks current auth + capture policy (CAP-006) BEFORE every upload, POSTs to
// the s1 batch endpoint, and reconciles per-item results + per-stream gap acks so only
// truly-ingested events are acked. All timing is injected (clock + backoff) so the decision logic
// is deterministic and timer-free.

export type BatchOutcomePlan = {
  ack: string[]
  nack: string[]
  drop: { item: ClaimedOutboxItem; code: string | null }[]
}

// Pure reconciliation of the server response against the claimed batch:
//  - permanent_rejected → drop (poison; auditing removes it so it is never retried forever).
//  - accepted/duplicate AND within the stream's contiguous prefix → ack (truly ingested; a
//    duplicate is an idempotent replay the server already holds).
//  - everything else (retryable, or accepted-beyond-a-gap, or missing) → nack for retry. Holding
//    a beyond-gap event is safe: a re-send is idempotent (returns `duplicate`).
export function planBatchOutcome(
  items: ClaimedOutboxItem[],
  response: AgentEventBatchResponse
): BatchOutcomePlan {
  const statusById = new Map(response.results.map((r) => [r.id, r]))
  const contiguousByStream = new Map(
    response.streamAcks.map((a) => [a.streamId, a.contiguousThrough])
  )
  const plan: BatchOutcomePlan = { ack: [], nack: [], drop: [] }
  for (const item of items) {
    const result = statusById.get(item.eventId)
    if (result?.status === 'permanent_rejected') {
      plan.drop.push({ item, code: result.code ?? null })
      continue
    }
    const ingested = result?.status === 'accepted' || result?.status === 'duplicate'
    const contiguous = contiguousByStream.get(item.streamId) ?? 0
    if (ingested && item.sequence <= contiguous) {
      plan.ack.push(item.eventId)
    } else {
      plan.nack.push(item.eventId)
    }
  }
  return plan
}

// Exponential backoff with a cap, keyed off a row's attempt count. Pure; the pump adds it to the
// injected clock to gate re-claim.
export function computeBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  const exp = baseMs * 2 ** Math.max(0, attempt)
  return Math.min(exp, capMs)
}

export type PumpOutcome =
  | { outcome: 'idle' }
  | { outcome: 'held_unauthorized' }
  | { outcome: 'purged'; purged: number }
  | { outcome: 'held_unauthorized_reclaimed'; reclaimed: number }
  // R5 s2b: the current signed ExecutionContext has expired; the batch is held (nacked) until a
  // fresh launch re-signs a valid context. An expired binding is never sent stale (CAP-006).
  | { outcome: 'held_expired_context'; reclaimed: number }
  // R5 s5: the current signed context's notBefore is in the future (not-yet-valid); the batch is
  // held rather than sent. Shouldn't happen in practice, but asserted so a premature context is
  // never sent within its future window.
  | { outcome: 'held_premature_context'; reclaimed: number }
  | { outcome: 'replayed'; acked: number }
  | { outcome: 'error'; status: number | null; nacked: number }
  | { outcome: 'uploaded'; acked: number; dropped: number; nacked: number }

export type UploadPumpDeps = {
  store: AgentEventOutboxStore
  uploadClient: AgentEventUploadClient
  organizationId: string
  producerId: string
  // CAP-006: current-auth + capture-policy gate, re-evaluated before every upload.
  isUploadAuthorized: () => boolean
  // R5 s2b (optional): the current signed ExecutionContext/SessionBinding to attach to each batch.
  // Returns null when no signing key is available → identity-only ingest (back-compat). Injected so
  // the pump stays deterministic. An expired context is refused, never sent stale.
  executionContext?: () => SignedExecutionContext | null
  clock: () => number
  // Fresh id per call (batchId, Idempotency-Key). Injected so tests stay deterministic.
  newId: () => string
  batchLimit: number
  maxBytes: number
  backoffBaseMs: number
  backoffCapMs: number
  // 'hold' keeps events for a possible re-grant; 'purge' drops them on revoke (CAP-006).
  revokePolicy: 'hold' | 'purge'
  onAudit?: (record: OutboxAuditRecord) => void
}

export type UploadPump = {
  pumpOnce: () => Promise<PumpOutcome>
}

export function createUploadPump(deps: UploadPumpDeps): UploadPump {
  // Per-batch anti-replay nonces, keyed to batchId so a retry reuses its nonce (retry-reuses-nonce).
  const submissionNonces: SubmissionNonceCache = new Map()

  function nextVisible(items: ClaimedOutboxItem[], now: number): number {
    const attempt = items.reduce((max, item) => Math.max(max, item.attemptCount), 0)
    return now + computeBackoffMs(attempt, deps.backoffBaseMs, deps.backoffCapMs)
  }

  async function pumpOnce(): Promise<PumpOutcome> {
    // CAP-006 gate #1: never claim or upload when unauthorized. A revoke-while-offline leaves the
    // outbox holding events; purge drops them, hold keeps them without uploading.
    if (!deps.isUploadAuthorized()) {
      if (deps.revokePolicy === 'purge') {
        return { outcome: 'purged', purged: deps.store.purgeUnacked(deps.onAudit) }
      }
      return { outcome: 'held_unauthorized' }
    }

    const now = deps.clock()
    const batch = deps.store.claimBatch(deps.batchLimit, deps.maxBytes, now)
    if (batch.length === 0) {
      return { outcome: 'idle' }
    }

    // CAP-006 gate #2: auth can flip during the claim; re-check right before the POST.
    if (!deps.isUploadAuthorized()) {
      if (deps.revokePolicy === 'purge') {
        return { outcome: 'purged', purged: deps.store.purgeUnacked(deps.onAudit) }
      }
      deps.store.nackBatch(
        batch.map((item) => item.eventId),
        now
      )
      return { outcome: 'held_unauthorized_reclaimed', reclaimed: batch.length }
    }

    // R5 s2b: attach the current signed ExecutionContext + SessionBinding validity-window so the
    // producer↔session bind is cryptographically verifiable. A null context means no signing key
    // (back-compat identity bind); an EXPIRED context is refused here and the batch is held until a
    // fresh launch re-signs it — an expired binding must never be sent stale (CAP-006).
    let executionContext: SignedExecutionContext | undefined
    if (deps.executionContext) {
      const signed = deps.executionContext()
      if (signed) {
        if (now < signed.context.notBefore) {
          deps.store.nackBatch(
            batch.map((item) => item.eventId),
            nextVisible(batch, now)
          )
          return { outcome: 'held_premature_context', reclaimed: batch.length }
        }
        if (now > signed.context.notAfter) {
          deps.store.nackBatch(
            batch.map((item) => item.eventId),
            nextVisible(batch, now)
          )
          return { outcome: 'held_expired_context', reclaimed: batch.length }
        }
        executionContext = signed
      }
    }

    const primaryStream = batch[0].streamId
    const batchId = deps.newId()
    // A signed-context batch carries a one-time-use nonce (anti-replay). Identity-only batches
    // send neither, so the back-compat path is unchanged.
    const submissionNonce = executionContext
      ? resolveSubmissionNonce(batchId, submissionNonces, deps.newId)
      : undefined
    const request: AgentEventBatchRequest = {
      batchId,
      producerId: deps.producerId,
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      events: batch.map((item) => item.envelope),
      // clientCheckpoint carries the stored gap-aware cursor for the batch's primary stream so
      // the server also re-acks it.
      clientCheckpoint: {
        streamId: primaryStream,
        lastServerAck: deps.store.getCursor(primaryStream)
      },
      ...(executionContext ? { executionContext } : {}),
      ...(submissionNonce ? { submissionNonce } : {})
    }

    let response: AgentEventBatchResponse
    try {
      response = await deps.uploadClient.upload(deps.organizationId, request, deps.newId())
    } catch (error) {
      const status = error instanceof AgentEventUploadError ? error.status : null
      if (status === 409) {
        // Idempotent replay: the server already processed this batch key — treat as acked so we
        // do not retry forever.
        deps.store.ackBatch(batch.map((item) => item.eventId))
        return { outcome: 'replayed', acked: batch.length }
      }
      deps.store.nackBatch(
        batch.map((item) => item.eventId),
        nextVisible(batch, now)
      )
      return { outcome: 'error', status, nacked: batch.length }
    }

    const plan = planBatchOutcome(batch, response)
    if (plan.ack.length > 0) {
      deps.store.ackBatch(plan.ack)
    }
    if (plan.drop.length > 0) {
      // Remove poison events and audit each — a permanent rejection must not be lost silently.
      deps.store.ackBatch(plan.drop.map((entry) => entry.item.eventId))
      for (const entry of plan.drop) {
        deps.onAudit?.({
          eventId: entry.item.eventId,
          streamId: entry.item.streamId,
          sequence: entry.item.sequence,
          byteSize: entry.item.byteSize,
          assertion: entry.item.assertion,
          reason: 'permanent_rejected'
        })
      }
    }
    if (plan.nack.length > 0) {
      deps.store.nackBatch(plan.nack, nextVisible(batch, now))
    }
    for (const ack of response.streamAcks) {
      deps.store.advanceCursor(ack.streamId, ack.contiguousThrough)
    }
    return {
      outcome: 'uploaded',
      acked: plan.ack.length,
      dropped: plan.drop.length,
      nacked: plan.nack.length
    }
  }

  return { pumpOnce }
}
