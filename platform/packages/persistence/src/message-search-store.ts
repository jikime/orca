import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import type { MessageVisibility } from './message-store'
import { withTenantTransaction } from './tenant-transaction'

/**
 * A search hit: the base message summary consistent with message.v1 (no reply count /
 * reactions / attachments — those are read-model extras of the channel timeline, not
 * search). channelId is included so the client knows which channel a hit belongs to.
 */
export type MessageSearchSummary = {
  id: string
  organizationId: string
  channelId: string
  authorId: string
  body: string
  visibility: MessageVisibility
  version: number
  createdAt: string
}

export type SearchMessagesResult = {
  items: MessageSearchSummary[]
  nextCursor: string | null
}

type SearchRow = {
  id: string
  organization_id: string
  channel_id: string
  author_user_id: string
  body: string
  visibility: string
  version: string | number
  created_at: Date | string
}

/**
 * Full-text search over message bodies, most-recent-first. Two independent gates:
 *   1. RLS binds the org (tenant_isolation on collaboration.messages).
 *   2. An explicit join to channel_members on the REQUESTING user — RLS gates the org,
 *      not per-channel membership, so a user must never see a hit from a channel they
 *      are not on even within their org. This join is the core isolation property.
 * The match uses websearch_to_tsquery so user query syntax is parsed safely and fully
 * parameterized (never string-concatenated). Ranking is recency only for v1; ts_rank
 * scoring could be layered later.
 */
export async function searchMessages(
  db: Kysely<Database>,
  input: {
    organizationId: string
    userId: string
    query: string
    limit: number
    afterId?: string
  }
): Promise<SearchMessagesResult> {
  const limit = Math.min(Math.max(input.limit, 1), 50)
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    let query = trx
      .selectFrom('collaboration.messages as m')
      // Member-scope: only channels where the requesting user is on the roster.
      .innerJoin('collaboration.channel_members as cm', (join) =>
        join.onRef('cm.channel_id', '=', 'm.channel_id').on('cm.user_id', '=', input.userId)
      )
      .select([
        'm.id',
        'm.organization_id',
        'm.channel_id',
        'm.author_user_id',
        'm.body',
        'm.visibility',
        'm.version',
        'm.created_at'
      ])
      .where(sql<boolean>`m.search_tsv @@ websearch_to_tsquery('simple', ${input.query})`)
    if (input.afterId) {
      // Keyset comparison entirely in SQL so the cursor's microsecond timestamp keeps
      // full precision (a JS Date round-trip truncates to ms). Descending, so strictly
      // less-than the referenced (created_at, id) tuple.
      query = query.where(
        sql<boolean>`(m.created_at, m.id) < (select created_at, id from collaboration.messages where id = ${input.afterId})`
      )
    }
    const rows = (await query
      .orderBy('m.created_at', 'desc')
      .orderBy('m.id', 'desc')
      .limit(limit)
      .execute()) as SearchRow[]
    const items = rows.map(mapRow)
    const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null
    return { items, nextCursor }
  })
}

function mapRow(row: SearchRow): MessageSearchSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    channelId: row.channel_id,
    authorId: row.author_user_id,
    body: row.body,
    visibility: row.visibility as MessageVisibility,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString()
  }
}
