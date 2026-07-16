import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangedMessage,
  decodeCursor,
  encodeCursor,
  parseResourceChangeCloudEvent,
  type ResourceChangedMessage
} from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

export const DEFAULT_CHANGES_LIMIT = 50
export const MAX_CHANGES_LIMIT = 200

export type ResourceChangePage = {
  items: ResourceChangedMessage[]
  nextCursor: string | null
  hasMore: boolean
}

export type ListResourceChangesInput = {
  afterCursor?: string | null
  limit?: number
}

export type ListResourceChangesResult =
  | { ok: true; page: ResourceChangePage }
  // The cursor is not one this server issued (or is past retention) → 410 Gone.
  | { ok: false; reason: 'cursor_invalid' }

/**
 * The authoritative recovery feed (doc 23 :314-316): published changes for the
 * org, ordered by the per-org sequence, after the client's cursor. RLS scopes it
 * to the org context, so a client cannot read another tenant's changes.
 */
export async function listResourceChanges(
  db: Kysely<Database>,
  organizationId: string,
  input: ListResourceChangesInput = {}
): Promise<ListResourceChangesResult> {
  let afterSequence = 0
  if (input.afterCursor) {
    const decoded = decodeCursor(input.afterCursor)
    if (decoded === null) {
      return { ok: false, reason: 'cursor_invalid' }
    }
    afterSequence = decoded
  }
  const limit = Math.max(1, Math.min(MAX_CHANGES_LIMIT, input.limit ?? DEFAULT_CHANGES_LIMIT))

  const page = await withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('operations.outbox_events')
      .select(['payload', 'stream_sequence'])
      .where('published_at', 'is not', null)
      .where(sql<boolean>`stream_sequence > ${afterSequence}`)
      .orderBy('stream_sequence')
      .limit(limit + 1)
      .execute()

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const items = pageRows.flatMap((row) => {
      const change = parseResourceChangeCloudEvent(row.payload)
      if (!change) {
        return []
      }
      return [
        buildResourceChangedMessage(organizationId, change, encodeCursor(row.stream_sequence ?? 0))
      ]
    })
    // Keep the client's position advancing: hand back the last cursor so it can
    // poll /changes?after= again; null only when there is nothing at all.
    const lastCursor = items.at(-1)?.cursor ?? input.afterCursor ?? null
    return { items, nextCursor: lastCursor, hasMore } satisfies ResourceChangePage
  })

  return { ok: true, page }
}

/** The highest published sequence for the org (0 if none) — the current cursor
 *  advertised in the Realtime welcome and used to size the reconnect gap. */
export async function getLatestPublishedSequence(
  db: Kysely<Database>,
  organizationId: string
): Promise<number> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('operations.outbox_events')
      .select(sql<string | null>`max(stream_sequence)`.as('max_sequence'))
      .where('published_at', 'is not', null)
      .executeTakeFirst()
    return row?.max_sequence ? Number(row.max_sequence) : 0
  })
}
