import { sql, type Kysely } from 'kysely'
import {
  mapAgentSessionIntake,
  type AgentSessionIntake,
  type IntakeSourceType,
  type IntakeStatus
} from './agent-session-intake-store'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// R5 slice 4b: the intake-queue SEARCH read (doc 19 :162, doc 24 host scope). Lists the queue —
// pending by default — filterable by capture scope (host / workspace / provider / source_type),
// newest-first and keyset-paged by an opaque (created_at, id) cursor.

export type AgentSessionIntakePage = {
  items: AgentSessionIntake[]
  nextCursor: string | null
}

export type ListAgentSessionIntakeOptions = {
  status?: IntakeStatus
  hostId?: string
  workspaceId?: string
  provider?: string
  sourceType?: IntakeSourceType
  limit?: number
  cursor?: string | null
}

const CURSOR_SEPARATOR = '|'

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}${CURSOR_SEPARATOR}${id}`).toString('base64url')
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf-8').split(CURSOR_SEPARATOR)
  if (createdAt === undefined || id === undefined) {
    return null
  }
  return { createdAt, id }
}

/**
 * Lists the intake queue for an org, RLS-scoped. Defaults to `pending` (the actionable queue);
 * pass status to inspect assigned/dismissed. Filters compose (AND). Keyset-paged newest-first by
 * (created_at, id) with millisecond precision, matching the provenance read's cursor idiom.
 */
export async function listAgentSessionIntake(
  db: Kysely<Database>,
  organizationId: string,
  options: ListAgentSessionIntakeOptions = {}
): Promise<AgentSessionIntakePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const status = options.status ?? 'pending'
  const cursor = options.cursor ? decodeCursor(options.cursor) : null
  return withTenantTransaction(db, organizationId, async (trx) => {
    // The cursor round-trips through an ISO-ms string, so page at millisecond precision (the DB
    // value's microseconds cannot be reconstructed from a JS Date).
    const createdAtMs = sql<Date>`date_trunc('milliseconds', created_at)`
    const cursorCreatedAt = cursor ? new Date(cursor.createdAt) : null
    let query = trx
      .selectFrom('execution.agent_session_intake')
      .selectAll()
      .where('status', '=', status)
    if (options.hostId !== undefined) {
      query = query.where('host_id', '=', options.hostId)
    }
    if (options.workspaceId !== undefined) {
      query = query.where('workspace_id', '=', options.workspaceId)
    }
    if (options.provider !== undefined) {
      query = query.where('provider', '=', options.provider)
    }
    if (options.sourceType !== undefined) {
      query = query.where('source_type', '=', options.sourceType)
    }
    if (cursor && cursorCreatedAt) {
      query = query.where((eb) =>
        eb.or([
          eb(createdAtMs, '<', cursorCreatedAt),
          eb.and([eb(createdAtMs, '=', cursorCreatedAt), eb('id', '<', cursor.id)])
        ])
      )
    }
    const rows = await query
      .orderBy(createdAtMs, 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute()

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const last = pageRows.at(-1)
    const nextCursor =
      hasMore && last ? encodeCursor(new Date(last.created_at).toISOString(), last.id) : null

    return {
      items: pageRows.map((row) => mapAgentSessionIntake(row)),
      nextCursor
    }
  })
}
