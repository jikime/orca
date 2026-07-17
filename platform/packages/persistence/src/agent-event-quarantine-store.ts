import { createHash, randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// R5 OPS-001: the server-side QUARANTINE (dead-letter) for poison agent events (doc 20 OPS-001).
// When the ingest loop per-item REJECTS an event (so its valid batch siblings still commit —
// progress-around-poison), it parks the rejected event here so the poison is durably visible to
// operators, not just a transient batch status. Mirrors the R2 outbox dead-letter store pattern.
// METADATA ONLY: the raw poison body is never stored — only its reason, a content hash, and byte
// size — so a secret or a huge payload can never leak into or bloat the quarantine.

export type QuarantineReasonCode =
  | 'schema_invalid'
  | 'provenance_invalid'
  | 'oversized'
  | 'producer_mismatch'
  | 'session_not_found'
  | 'session_closed'
  | 'org_mismatch'

export type QuarantineStatus = 'quarantined' | 'recovered' | 'discarded'

export type AgentEventQuarantine = {
  id: string
  organizationId: string
  eventId: string
  agentSessionId: string
  streamId: string
  sequence: number
  reasonCode: QuarantineReasonCode
  contentHash: string | null
  payloadSizeBytes: number
  status: QuarantineStatus
  resolvedBy: string | null
  resolvedAt: string | null
  version: number
  quarantinedAt: string
  updatedAt: string
}

type QuarantineRow = {
  id: string
  organization_id: string
  event_id: string
  agent_session_id: string
  stream_id: string
  sequence: string | number
  reason_code: string
  content_hash: string | null
  payload_size_bytes: number
  status: string
  resolved_by: string | null
  resolved_at: Date | string | null
  version: string | number
  quarantined_at: Date | string
  updated_at: Date | string
}

export function mapAgentEventQuarantine(row: QuarantineRow): AgentEventQuarantine {
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventId: row.event_id,
    agentSessionId: row.agent_session_id,
    streamId: row.stream_id,
    sequence: Number(row.sequence),
    reasonCode: row.reason_code as QuarantineReasonCode,
    contentHash: row.content_hash,
    payloadSizeBytes: Number(row.payload_size_bytes),
    status: row.status as QuarantineStatus,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    version: Number(row.version),
    quarantinedAt: new Date(row.quarantined_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

// The metadata-only fingerprint of a poison body: a sha256 hash + byte size, NEVER the bytes.
export function fingerprintPayload(body: unknown): {
  contentHash: string | null
  payloadSizeBytes: number
} {
  const serialized = JSON.stringify(body ?? {})
  const payloadSizeBytes = Buffer.byteLength(serialized, 'utf-8')
  const contentHash = `sha256:${createHash('sha256').update(serialized).digest('hex')}`
  return { contentHash, payloadSizeBytes }
}

export type QuarantineEventInput = {
  eventId: string
  agentSessionId: string
  streamId: string
  sequence: number
  reasonCode: QuarantineReasonCode
  contentHash: string | null
  payloadSizeBytes: number
}

/**
 * BEST-EFFORT quarantine write, inside the caller's ingest tenant tx. A clean per-item rejection
 * must never be escalated into a whole-batch failure by a quarantine problem, so the insert +
 * audit run in a SAVEPOINT: if they fail, we ROLL BACK TO the savepoint (the batch tx stays
 * healthy) and swallow the error. Idempotent on (org, event_id) — a replayed batch re-rejecting
 * the same poison never double-quarantines. Writes an `agent_event.quarantined` audit fact.
 */
export async function quarantineEventTx(
  trx: Transaction<Database>,
  organizationId: string,
  actorId: string | null,
  input: QuarantineEventInput
): Promise<void> {
  // A manual SAVEPOINT on the SAME connection isolates the quarantine work: on failure we ROLL
  // BACK TO it and the batch tx stays healthy (Kysely 0.27 has no nested-savepoint helper, and a
  // failed statement otherwise aborts the whole tx). The name is a sanitized hex id — no injection.
  const savepoint = `quarantine_sp_${randomUUID().replace(/-/g, '')}`
  await sql.raw(`savepoint ${savepoint}`).execute(trx)
  try {
    const inserted = await trx
      .insertInto('execution.agent_event_quarantine')
      .values({
        organization_id: organizationId,
        event_id: input.eventId,
        agent_session_id: input.agentSessionId,
        stream_id: input.streamId,
        sequence: input.sequence,
        reason_code: input.reasonCode,
        content_hash: input.contentHash,
        payload_size_bytes: input.payloadSizeBytes
      })
      .onConflict((oc) => oc.columns(['organization_id', 'event_id']).doNothing())
      .returning('id')
      .executeTakeFirst()
    if (inserted) {
      await trx
        .insertInto('audit.audit_events')
        .values({
          organization_id: organizationId,
          actor_id: actorId,
          action: 'agent_event.quarantined',
          target_type: 'agent_event',
          target_id: input.eventId,
          // Metadata only: the reason + byte size; never the poison body.
          after_digest: `${input.reasonCode}:${input.payloadSizeBytes}`
        })
        .execute()
    }
    // A duplicate (replay of an already-quarantined poison) is a no-op — no second row or audit.
    await sql.raw(`release savepoint ${savepoint}`).execute(trx)
  } catch {
    // best-effort-quarantine: a quarantine-write failure must not fail a clean per-item rejection,
    // so the batch's valid events still commit. Roll back only the quarantine work; the rejection
    // status still reaches the client, only the durable quarantine record is (rarely) missed.
    await sql.raw(`rollback to savepoint ${savepoint}`).execute(trx)
  }
}

export type AgentEventQuarantinePage = {
  items: AgentEventQuarantine[]
  nextCursor: string | null
}

export type ListAgentEventQuarantineOptions = {
  status?: QuarantineStatus
  limit?: number
  cursor?: string | null
}

const CURSOR_SEPARATOR = '|'

function encodeCursor(quarantinedAt: string, id: string): string {
  return Buffer.from(`${quarantinedAt}${CURSOR_SEPARATOR}${id}`).toString('base64url')
}

function decodeCursor(cursor: string): { quarantinedAt: string; id: string } | null {
  const [quarantinedAt, id] = Buffer.from(cursor, 'base64url')
    .toString('utf-8')
    .split(CURSOR_SEPARATOR)
  if (quarantinedAt === undefined || id === undefined) {
    return null
  }
  return { quarantinedAt, id }
}

/**
 * Lists the quarantine queue for an org, RLS-scoped, newest-first and keyset-paged by an opaque
 * (quarantined_at, id) cursor. Optional status filter; metadata only (there is no raw poison body
 * to return). Cross-tenant isolation is enforced by the RLS tenant pair, same as every read here.
 */
export async function listAgentEventQuarantine(
  db: Kysely<Database>,
  organizationId: string,
  options: ListAgentEventQuarantineOptions = {}
): Promise<AgentEventQuarantinePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const cursor = options.cursor ? decodeCursor(options.cursor) : null
  return withTenantTransaction(db, organizationId, async (trx) => {
    // The cursor round-trips through an ISO-ms string, so page at millisecond precision.
    const quarantinedAtMs = sql<Date>`date_trunc('milliseconds', quarantined_at)`
    const cursorQuarantinedAt = cursor ? new Date(cursor.quarantinedAt) : null
    let query = trx.selectFrom('execution.agent_event_quarantine').selectAll()
    if (options.status !== undefined) {
      query = query.where('status', '=', options.status)
    }
    if (cursor && cursorQuarantinedAt) {
      query = query.where((eb) =>
        eb.or([
          eb(quarantinedAtMs, '<', cursorQuarantinedAt),
          eb.and([eb(quarantinedAtMs, '=', cursorQuarantinedAt), eb('id', '<', cursor.id)])
        ])
      )
    }
    const rows = await query
      .orderBy(quarantinedAtMs, 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute()

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const last = pageRows.at(-1)
    const nextCursor =
      hasMore && last ? encodeCursor(new Date(last.quarantined_at).toISOString(), last.id) : null

    return {
      items: pageRows.map((row) => mapAgentEventQuarantine(row)),
      nextCursor
    }
  })
}

export type ResolveQuarantineAction = 'discard' | 'recover'

export type ResolveQuarantineResult =
  | { ok: true; quarantine: AgentEventQuarantine }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'already_terminal'; status: QuarantineStatus }

/**
 * Operator recovery: transitions a `quarantined` row to `discarded` (drop the poison) or
 * `recovered` (marked handled — full re-ingest of a corrected event is a client concern, seam
 * left here) with OCC on `version` (If-Match). An already-resolved row is terminal (409). Audits
 * `agent_event.discarded` / `agent_event.recovered`. Never touches the never-stored payload body.
 */
export async function resolveQuarantine(
  db: Kysely<Database>,
  input: {
    organizationId: string
    quarantineId: string
    actorUserId: string
    action: ResolveQuarantineAction
    expectedVersion: number
  }
): Promise<ResolveQuarantineResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const existing = await trx
      .selectFrom('execution.agent_event_quarantine')
      .selectAll()
      .where('id', '=', input.quarantineId)
      .executeTakeFirst()
    if (!existing) {
      return { ok: false, reason: 'not_found' }
    }
    const current = mapAgentEventQuarantine(existing)
    if (current.status !== 'quarantined') {
      return { ok: false, reason: 'already_terminal', status: current.status }
    }
    if (current.version !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion: current.version }
    }
    const nextStatus: QuarantineStatus = input.action === 'discard' ? 'discarded' : 'recovered'
    const newVersion = current.version + 1
    const now = new Date()
    const updated = await trx
      .updateTable('execution.agent_event_quarantine')
      .set({
        status: nextStatus,
        resolved_by: input.actorUserId,
        resolved_at: now,
        version: newVersion,
        updated_at: now
      })
      .where('id', '=', current.id)
      // OCC guard on the version we read — loses a concurrent race → version_conflict.
      .where('version', '=', String(current.version))
      .returningAll()
      .executeTakeFirst()
    if (!updated) {
      return { ok: false, reason: 'version_conflict', currentVersion: current.version }
    }
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: input.action === 'discard' ? 'agent_event.discarded' : 'agent_event.recovered',
        target_type: 'agent_event',
        target_id: current.eventId,
        after_digest: `${nextStatus}:${current.reasonCode}`
      })
      .execute()
    return { ok: true, quarantine: mapAgentEventQuarantine(updated) }
  })
}
