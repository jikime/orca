import { sql, type Kysely } from 'kysely'
import { loadAgentSessionTx, type AgentSession } from './agent-session-store'
import {
  allowedVisibilitiesForScope,
  normalizeClassification,
  payloadPreview,
  requiresRedaction,
  type SensitivityClassification,
  type VisibilityScope
} from './agent-visibility-scope'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// R5 slice 5a: the SCOPED EVIDENCE SEARCH — the surface that proves the exit condition "내부
// prompt와 제한 tool output이 고객 Evidence와 검색 결과에 노출되지 않는다" (doc 14 §R5, doc 24
// CAP-002). No search surface existed over the append-only event log before this slice, so this is
// a minimal, scoped one: it filters by the requested VISIBILITY SCOPE (above-scope events are
// absent), REDACTS the payload preview server-side per classification, and — crucially — a `q`
// term is matched ONLY against records that are not redacted at this scope, so restricted or
// above-scope content can never surface through a search snippet or inflate a result count.

export type AgentEvidenceItem = {
  eventId: string
  type: string
  visibility: string
  classification: string
  turnId: string | null
  redacted: boolean
  preview: string
  occurredAt: string
  receivedAt: string
}

export type AgentSessionEvidence = {
  session: AgentSession
  scope: VisibilityScope
  items: AgentEvidenceItem[]
  nextCursor: string | null
}

const CURSOR_SEPARATOR = '|'

function encodeCursor(receivedAt: string, id: string): string {
  return Buffer.from(`${receivedAt}${CURSOR_SEPARATOR}${id}`).toString('base64url')
}

function decodeCursor(cursor: string): { receivedAt: string; id: string } | null {
  const [receivedAt, id] = Buffer.from(cursor, 'base64url')
    .toString('utf-8')
    .split(CURSOR_SEPARATOR)
  if (receivedAt === undefined || id === undefined) {
    return null
  }
  return { receivedAt, id }
}

// The classifications that ARE redacted at this scope — a `q` match against these is suppressed so
// no redacted content leaks through a search snippet or count.
function redactedClassificationsAtScope(scope: VisibilityScope): SensitivityClassification[] {
  return (['public', 'internal', 'project_confidential', 'restricted'] as const).filter((c) =>
    requiresRedaction(c, scope)
  )
}

// Escape a user term so ILIKE treats it literally (no wildcard injection via % or _).
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Searches a session's append-only events as scoped Evidence. Returns null if the session is not
 * visible in this org (RLS-scoped). Above-scope events are absent; visible-but-sensitive events
 * are returned with a redacted preview; a `q` term never matches a redacted event.
 */
export async function searchSessionEvidence(
  db: Kysely<Database>,
  organizationId: string,
  sessionId: string,
  options: {
    scope?: VisibilityScope
    q?: string | null
    limit?: number
    cursor?: string | null
  } = {}
): Promise<AgentSessionEvidence | null> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const cursor = options.cursor ? decodeCursor(options.cursor) : null
  // Default-deny: an unspecified scope reads at the narrowest audience (`customer`).
  const scope = options.scope ?? 'customer'
  const allowedVisibilities = allowedVisibilitiesForScope(scope)
  const redactedClassifications = redactedClassificationsAtScope(scope)
  const term = options.q && options.q.trim().length > 0 ? options.q.trim() : null
  return withTenantTransaction(db, organizationId, async (trx) => {
    const session = await loadAgentSessionTx(trx, sessionId)
    if (!session) {
      return null
    }
    const receivedAtMs = sql<Date>`date_trunc('milliseconds', received_at)`
    const cursorReceivedAt = cursor ? new Date(cursor.receivedAt) : null
    let query = trx
      .selectFrom('execution.agent_events')
      .select([
        'id',
        'event_id',
        'type',
        'visibility',
        'classification',
        'turn_id',
        'payload',
        'occurred_at',
        'received_at'
      ])
      .where('agent_session_id', '=', sessionId)
      .where('visibility', 'in', allowedVisibilities)
    if (term) {
      const pattern = `%${escapeLike(term)}%`
      // A term matches type OR payload text — but ONLY on records not redacted at this scope, so a
      // redacted/above-scope secret can never be surfaced (or even confirmed) via search.
      query = query.where((eb) =>
        eb.or([eb('type', 'ilike', pattern), eb(sql`payload::text`, 'ilike', pattern)])
      )
      if (redactedClassifications.length > 0) {
        query = query.where('classification', 'not in', redactedClassifications)
      }
    }
    if (cursor && cursorReceivedAt) {
      query = query.where((eb) =>
        eb.or([
          eb(receivedAtMs, '<', cursorReceivedAt),
          eb.and([eb(receivedAtMs, '=', cursorReceivedAt), eb('id', '<', cursor.id)])
        ])
      )
    }
    const rows = await query
      .orderBy(receivedAtMs, 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute()

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const last = pageRows.at(-1)
    const nextCursor =
      hasMore && last ? encodeCursor(new Date(last.received_at).toISOString(), last.id) : null

    return {
      session,
      scope,
      items: pageRows.map((row) => {
        const classification = normalizeClassification(row.classification)
        const { preview, redacted } = payloadPreview(row.payload, classification, scope)
        return {
          eventId: row.event_id,
          type: row.type,
          visibility: row.visibility,
          classification: row.classification,
          turnId: row.turn_id,
          redacted,
          preview,
          occurredAt: new Date(row.occurred_at).toISOString(),
          receivedAt: new Date(row.received_at).toISOString()
        }
      }),
      nextCursor
    }
  })
}
