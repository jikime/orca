import type { Transaction } from 'kysely'
import type { Database } from './database-schema'

// R5 slice 4a: project one append-only provenance agent_event into the queryable
// execution.agent_provenance row (doc 19 :265-271, doc 20 CAP-004/CAP-005). Provenance
// events are ordinary agent_events whose `type` is `ai.pielab.agent.provenance.<kind>.v1`;
// this module derives the structured projection from the event's payload. It runs inside the
// s1 ingest tenant tx AFTER the event row is inserted, so it reuses (org, eventId) idempotency.

const PROVENANCE_TYPE_PATTERN = /^ai\.pielab\.agent\.provenance\.([a-z_]+)\.v[1-9][0-9]*$/

export type ProvenanceKind =
  | 'file_change'
  | 'artifact'
  | 'commit'
  | 'pull_request'
  | 'test_result'
  | 'build_result'

// The three trust domains that MUST stay separate (doc 19 :216-231):
//  - local_observed : Pie directly observed it (Hook / Git / test). First-hand but NOT verified.
//  - server_verified: a provider webhook / provider API / signed CI attested it.
//  - declared       : an agent/user CLAIM. NEVER evidence of completion/approval (CAP-005).
export type ProvenanceTrustDomain = 'local_observed' | 'server_verified' | 'declared'

const PROVENANCE_KINDS = new Set<ProvenanceKind>([
  'file_change',
  'artifact',
  'commit',
  'pull_request',
  'test_result',
  'build_result'
])

/** The kind carried by a provenance event `type`, or null if `type` is not a provenance event. */
export function provenanceKindOfType(type: string): ProvenanceKind | null {
  const match = PROVENANCE_TYPE_PATTERN.exec(type)
  const kind = match?.[1]
  return kind && PROVENANCE_KINDS.has(kind as ProvenanceKind) ? (kind as ProvenanceKind) : null
}

export function isProvenanceType(type: string): boolean {
  return provenanceKindOfType(type) !== null
}

/**
 * Maps the event's assertion + producer trust domain to a provenance trust domain.
 * `declared` wins unconditionally: an agent/user claim is never promoted to evidence even if it
 * carries a content hash (CAP-005). A first-hand observation is `server_verified` only when a
 * provider/CI attested it (`producer.trustDomain === server_verified`); otherwise it is a
 * locally-observed event — first-hand, but NOT server-verified.
 */
// TODO(pie-r5-s4-live): the real client git/test observers and provider (GitHub/GitLab)
// webhooks + signed-CI receivers plug in HERE — they set producer.trustDomain=server_verified
// on the ingested envelope (a webhook/provider-API/signed-CI attestation), which this maps to
// server_verified. Until then, synthetic provenance envelopes exercise every domain via tests.
export function resolveProvenanceTrustDomain(
  assertion: 'observed' | 'declared' | 'verified',
  producerTrustDomain: 'client_observed' | 'provider_asserted' | 'server_verified'
): ProvenanceTrustDomain {
  if (assertion === 'declared') {
    return 'declared'
  }
  return producerTrustDomain === 'server_verified' ? 'server_verified' : 'local_observed'
}

// The structured provenance payload (envelope.data.payload.provenance). Provider-agnostic:
// PR and MR are one `pull_request` kind discriminated by `provider`, never GitHub-only naming.
export type ProvenancePayload = {
  kind: ProvenanceKind
  provider?: string | null
  repository?: string | null
  sourceRevision?: string | null
  commitSha?: string | null
  changeRequest?: {
    ref: string
    url?: string | null
    state?: string | null
    sourceBranch?: string | null
    targetBranch?: string | null
  } | null
  execution?: {
    command: string
    execEnvironment?: string | null
    exitCode: number
    parserVersion: string
  } | null
  fileChange?: { path: string; changeType?: string | null } | null
  artifactId?: string | null
  contentHash?: string | null
  workItemId?: string | null
  correctsProvenanceId?: string | null
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

/**
 * Parses + validates the provenance payload for a given kind, or returns null if malformed.
 * The kind from the event `type` is authoritative; a payload.kind that disagrees is rejected.
 * test_result/build_result require the command + exitCode + parserVersion an evidence record
 * must carry (doc 19 :269); pull_request requires a change-request ref.
 */
export function parseProvenancePayload(
  kind: ProvenanceKind,
  payload: Record<string, unknown> | undefined
): ProvenancePayload | null {
  const raw = payload?.provenance
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const p = raw as Record<string, unknown>
  if (p.kind !== undefined && p.kind !== kind) {
    return null
  }
  if (
    !optionalString(p.provider) ||
    !optionalString(p.repository) ||
    !optionalString(p.sourceRevision) ||
    !optionalString(p.commitSha) ||
    !optionalString(p.artifactId) ||
    !optionalString(p.contentHash) ||
    !optionalString(p.workItemId) ||
    !optionalString(p.correctsProvenanceId)
  ) {
    return null
  }
  const result: ProvenancePayload = { kind }
  assignCommon(result, p)

  if (kind === 'pull_request') {
    const cr = p.changeRequest as Record<string, unknown> | undefined
    if (!cr || typeof cr.ref !== 'string' || cr.ref.length === 0) {
      return null
    }
    if (
      !optionalString(cr.url) ||
      !optionalString(cr.state) ||
      !optionalString(cr.sourceBranch) ||
      !optionalString(cr.targetBranch)
    ) {
      return null
    }
    result.changeRequest = {
      ref: cr.ref,
      url: (cr.url as string | null | undefined) ?? null,
      state: (cr.state as string | null | undefined) ?? null,
      sourceBranch: (cr.sourceBranch as string | null | undefined) ?? null,
      targetBranch: (cr.targetBranch as string | null | undefined) ?? null
    }
  }

  if (kind === 'test_result' || kind === 'build_result') {
    const ex = p.execution as Record<string, unknown> | undefined
    if (
      !ex ||
      typeof ex.command !== 'string' ||
      typeof ex.exitCode !== 'number' ||
      typeof ex.parserVersion !== 'string'
    ) {
      return null
    }
    if (!optionalString(ex.execEnvironment)) {
      return null
    }
    result.execution = {
      command: ex.command,
      execEnvironment: (ex.execEnvironment as string | null | undefined) ?? null,
      exitCode: ex.exitCode,
      parserVersion: ex.parserVersion
    }
  }

  if (kind === 'file_change') {
    const fc = p.fileChange as Record<string, unknown> | undefined
    if (!fc || typeof fc.path !== 'string' || fc.path.length === 0) {
      return null
    }
    if (!optionalString(fc.changeType)) {
      return null
    }
    result.fileChange = {
      path: fc.path,
      changeType: (fc.changeType as string | null | undefined) ?? null
    }
  }

  if (kind === 'artifact' && typeof result.artifactId !== 'string') {
    // An artifact provenance record must link the artifact it describes (doc 19 :265).
    return null
  }
  return result
}

function assignCommon(result: ProvenancePayload, p: Record<string, unknown>): void {
  result.provider = (p.provider as string | null | undefined) ?? null
  result.repository = (p.repository as string | null | undefined) ?? null
  result.sourceRevision = (p.sourceRevision as string | null | undefined) ?? null
  result.commitSha = (p.commitSha as string | null | undefined) ?? null
  result.artifactId = (p.artifactId as string | null | undefined) ?? null
  result.contentHash = (p.contentHash as string | null | undefined) ?? null
  result.workItemId = (p.workItemId as string | null | undefined) ?? null
  result.correctsProvenanceId = (p.correctsProvenanceId as string | null | undefined) ?? null
}

export type ProjectProvenanceInput = {
  sourceEventId: string
  agentRunId: string | null
  kind: ProvenanceKind
  trustDomain: ProvenanceTrustDomain
  occurredAt: string
  payload: ProvenancePayload
}

/**
 * Inserts the provenance projection row for one accepted event. A correction is a NEW revision:
 * when the payload cites `correctsProvenanceId`, this row's revision is the prior's + 1 and it
 * points back at the prior — the prior row is never mutated (append-only immutability, CAP-004).
 * Idempotent by (org, sourceEventId): a replayed event never creates a duplicate projection.
 * Returns the new provenance id, or null if the source event was already projected.
 */
export async function projectProvenanceFromEvent(
  trx: Transaction<Database>,
  organizationId: string,
  agentSessionId: string,
  input: ProjectProvenanceInput
): Promise<{ id: string; revision: number } | null> {
  const { payload } = input
  let revision = 1
  if (payload.correctsProvenanceId) {
    const prior = await trx
      .selectFrom('execution.agent_provenance')
      .select('revision')
      .where('id', '=', payload.correctsProvenanceId)
      .executeTakeFirst()
    // A correction advances the revision; if the prior is unknown, start a fresh chain at 1.
    revision = prior ? Number(prior.revision) + 1 : 1
  }
  const inserted = await trx
    .insertInto('execution.agent_provenance')
    .values({
      organization_id: organizationId,
      source_event_id: input.sourceEventId,
      agent_session_id: agentSessionId,
      agent_run_id: input.agentRunId,
      kind: input.kind,
      trust_domain: input.trustDomain,
      provider: payload.provider ?? null,
      repository: payload.repository ?? null,
      source_revision: payload.sourceRevision ?? null,
      commit_sha: payload.commitSha ?? null,
      change_request_ref: payload.changeRequest?.ref ?? null,
      change_request_url: payload.changeRequest?.url ?? null,
      change_request_state: payload.changeRequest?.state ?? null,
      source_branch: payload.changeRequest?.sourceBranch ?? null,
      target_branch: payload.changeRequest?.targetBranch ?? null,
      command: payload.execution?.command ?? null,
      exec_environment: payload.execution?.execEnvironment ?? null,
      exit_code: payload.execution?.exitCode ?? null,
      result_parser_version: payload.execution?.parserVersion ?? null,
      file_path: payload.fileChange?.path ?? null,
      change_type: payload.fileChange?.changeType ?? null,
      artifact_id: payload.artifactId ?? null,
      content_hash: payload.contentHash ?? null,
      work_item_id: payload.workItemId ?? null,
      revision,
      corrects_provenance_id: payload.correctsProvenanceId ?? null,
      occurred_at: input.occurredAt
    })
    // Idempotency at the projection layer too: a replayed source event is a no-op.
    .onConflict((oc) => oc.columns(['organization_id', 'source_event_id']).doNothing())
    .returning(['id', 'revision'])
    .executeTakeFirst()
  return inserted ? { id: inserted.id, revision: Number(inserted.revision) } : null
}
