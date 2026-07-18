import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import type {
  ArticleSourceType,
  ArticleVisibility,
  KnowledgeArticleResource
} from './knowledge-article-store'
import { withTenantTransaction } from './tenant-transaction'

/**
 * A knowledge-search hit: the article summary consistent with knowledge-article.v1, plus the
 * relevance rank. body is omitted from the wire summary — search returns pointers, not full documents.
 */
export type KnowledgeSearchHit = {
  id: string
  organizationId: string
  title: string
  status: 'draft' | 'in_review' | 'published' | 'archived'
  visibility: ArticleVisibility
  sourceType: ArticleSourceType
  sourceId: string | null
  reviewStatus: KnowledgeArticleResource['reviewStatus']
  projectId: string | null
  rank: number
}

export type KnowledgeSearchResult = { items: KnowledgeSearchHit[] }

type SearchRow = {
  id: string
  organization_id: string
  title: string
  status: string
  visibility: string
  source_type: string
  source_id: string | null
  review_status: string
  project_id: string | null
  rank: number | string
}

export type SearchKnowledgeArticlesInput = {
  organizationId: string
  query: string
  limit: number
  // search-filters-at-query-time: the caller's customer-facing permission is passed on EVERY query and
  // re-evaluated here, so revoking it (or flipping an article's visibility) changes the next result set
  // with no index to rebuild. "권한 회수가 ... 검색 색인에 반영된다."
  canSeeCustomer: boolean
}

/**
 * Permission-aware full-text search over PUBLISHED articles, ranked by ts_rank. Two gates, both at
 * query time:
 *   1. RLS binds the org (articles_tenant_isolation on knowledge.articles).
 *   2. visibility filter — every caller sees 'internal' articles; only a caller who may see customer
 *      content (canSeeCustomer) additionally sees 'customer' articles. Evaluated per query, never from
 *      a precomputed index, so a visibility/permission change is reflected on the next search.
 * The match uses plainto_tsquery so the user query is parsed safely and fully parameterized.
 */
export async function searchKnowledgeArticles(
  db: Kysely<Database>,
  input: SearchKnowledgeArticlesInput
): Promise<KnowledgeSearchResult> {
  const limit = Math.min(Math.max(input.limit, 1), 50)
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    let query = trx
      .selectFrom('knowledge.articles as a')
      .select([
        'a.id',
        'a.organization_id',
        'a.title',
        'a.status',
        'a.visibility',
        'a.source_type',
        'a.source_id',
        'a.review_status',
        'a.project_id',
        sql<number>`ts_rank(a.tsv, plainto_tsquery('simple', ${input.query}))`.as('rank')
      ])
      // Search surfaces only published knowledge, never drafts / in-review / archived.
      .where('a.status', '=', 'published')
      .where(sql<boolean>`a.tsv @@ plainto_tsquery('simple', ${input.query})`)
    if (!input.canSeeCustomer) {
      // A caller without the customer-facing permission is restricted to internal-visibility articles.
      query = query.where('a.visibility', '=', 'internal')
    }
    const rows = (await query
      .orderBy('rank', 'desc')
      .orderBy('a.id', 'asc')
      .limit(limit)
      .execute()) as SearchRow[]
    return { items: rows.map(mapHit) }
  })
}

function mapHit(row: SearchRow): KnowledgeSearchHit {
  return {
    id: row.id,
    organizationId: row.organization_id,
    title: row.title,
    status: row.status as KnowledgeSearchHit['status'],
    visibility: row.visibility as ArticleVisibility,
    sourceType: row.source_type as ArticleSourceType,
    sourceId: row.source_id,
    reviewStatus: row.review_status as KnowledgeArticleResource['reviewStatus'],
    projectId: row.project_id,
    rank: Number(row.rank)
  }
}
