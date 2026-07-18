import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { buildResourceChangeCloudEvent } from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

// R7 KNOWLEDGE BASE. Articles distilled from resolved tickets / remote sessions (or authored manually
// or by an AI) become searchable, permission-aware knowledge. Two load-bearing exit conditions live
// here: an AI-authored article requires human review before it may be published (publishArticle), and
// search filters by the caller's visibility permission at QUERY TIME (knowledge-search-query.ts).

export type ArticleStatus = 'draft' | 'in_review' | 'published' | 'archived'
export type ArticleVisibility = 'internal' | 'customer'
export type ArticleSourceType = 'manual' | 'ticket' | 'remote_session' | 'ai'
export type ArticleReviewStatus = 'unreviewed' | 'approved' | 'rejected'

export type KnowledgeArticleResource = {
  id: string
  organizationId: string
  title: string
  body: string
  status: ArticleStatus
  visibility: ArticleVisibility
  sourceType: ArticleSourceType
  sourceId: string | null
  reviewStatus: ArticleReviewStatus
  reviewedBy: string | null
  reviewedAt: string | null
  authorUserId: string
  projectId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

// A model-authored article may not be published while unreviewed — the single predicate the publish
// gate consults. "모델 출력이 승인을 대체하지 않는다": human approval is a precondition, not a substitute.
export function isArticlePublishable(
  sourceType: ArticleSourceType,
  reviewStatus: ArticleReviewStatus
): boolean {
  return sourceType !== 'ai' || reviewStatus === 'approved'
}

type ArticleRow = {
  id: string
  organization_id: string
  title: string
  body: string
  status: string
  visibility: string
  source_type: string
  source_id: string | null
  review_status: string
  reviewed_by: string | null
  reviewed_at: Date | string | null
  author_user_id: string
  project_id: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapArticle(row: ArticleRow): KnowledgeArticleResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    title: row.title,
    body: row.body,
    status: row.status as ArticleStatus,
    visibility: row.visibility as ArticleVisibility,
    sourceType: row.source_type as ArticleSourceType,
    sourceId: row.source_id,
    reviewStatus: row.review_status as ArticleReviewStatus,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    authorUserId: row.author_user_id,
    projectId: row.project_id,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

async function emitArticleEvent(
  trx: Transaction<Database>,
  organizationId: string,
  articleId: string,
  version: number,
  changeKind: 'created' | 'updated'
): Promise<void> {
  const outboxId = randomUUID()
  const occurredAt = new Date().toISOString()
  const cloudEvent = buildResourceChangeCloudEvent({
    organizationId,
    eventId: outboxId,
    resourceType: 'knowledge_article',
    resourceId: articleId,
    changeKind,
    version,
    occurredAt
  })
  await trx
    .insertInto('operations.outbox_events')
    .values({
      id: outboxId,
      organization_id: organizationId,
      aggregate_type: 'knowledge_article',
      aggregate_id: articleId,
      aggregate_version: version,
      event_type: cloudEvent.type,
      event_schema_version: 1,
      payload: JSON.stringify(cloudEvent),
      occurred_at: occurredAt,
      available_at: occurredAt
    })
    .execute()
}

async function audit(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  action: string,
  articleId: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorUserId,
      action,
      target_type: 'knowledge_article',
      target_id: articleId
    })
    .execute()
}

export type CreateKnowledgeArticleInput = {
  organizationId: string
  actorUserId: string
  title: string
  body: string
  visibility?: ArticleVisibility
  sourceType?: ArticleSourceType
  sourceId?: string | null
  projectId?: string | null
}

/** Creates an article in status='draft', review_status='unreviewed'. A draft is inert until published. */
export async function createKnowledgeArticle(
  db: Kysely<Database>,
  input: CreateKnowledgeArticleInput
): Promise<KnowledgeArticleResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('knowledge.articles')
      .values({
        organization_id: input.organizationId,
        title: input.title,
        body: input.body,
        status: 'draft',
        visibility: input.visibility ?? 'internal',
        source_type: input.sourceType ?? 'manual',
        source_id: input.sourceId ?? null,
        review_status: 'unreviewed',
        author_user_id: input.actorUserId,
        project_id: input.projectId ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(trx, input.organizationId, input.actorUserId, 'knowledge.article.created', row.id)
    await emitArticleEvent(trx, input.organizationId, row.id, 1, 'created')
    return mapArticle(row)
  })
}

export async function getKnowledgeArticle(
  db: Kysely<Database>,
  organizationId: string,
  articleId: string
): Promise<KnowledgeArticleResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('knowledge.articles')
      .selectAll()
      .where('id', '=', articleId)
      .executeTakeFirst()
    return row ? mapArticle(row) : null
  })
}

export type KnowledgeArticlePage = {
  items: KnowledgeArticleResource[]
  nextCursor: string | null
}

export async function listKnowledgeArticles(
  db: Kysely<Database>,
  organizationId: string,
  options: { limit?: number; cursor?: string | null; projectId?: string | null } = {}
): Promise<KnowledgeArticlePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('knowledge.articles')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.projectId) {
      query = query.where('project_id', '=', options.projectId)
    }
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapArticle), nextCursor }
  })
}

export type UpdateKnowledgeArticleResult =
  | { ok: true; article: KnowledgeArticleResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  // Only a draft / in_review article may be edited in place; a published/archived one is frozen.
  | { ok: false; reason: 'not_editable'; from: ArticleStatus }

export type UpdateKnowledgeArticleInput = {
  organizationId: string
  articleId: string
  actorUserId: string
  expectedVersion: number
  title?: string
  body?: string
  visibility?: ArticleVisibility
  projectId?: string | null
}

/** Edits an article body/metadata under OCC. Refused once the article has been published or archived. */
export async function updateKnowledgeArticle(
  db: Kysely<Database>,
  input: UpdateKnowledgeArticleInput
): Promise<UpdateKnowledgeArticleResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('knowledge.articles')
      .selectAll()
      .where('id', '=', input.articleId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as ArticleStatus
    if (from !== 'draft' && from !== 'in_review') {
      return { ok: false, reason: 'not_editable', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('knowledge.articles')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        ...(input.projectId === undefined ? {} : { project_id: input.projectId })
      })
      .where('id', '=', input.articleId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'knowledge.article.updated',
      updated.id
    )
    await emitArticleEvent(trx, input.organizationId, updated.id, newVersion, 'updated')
    return { ok: true, article: mapArticle(updated) }
  })
}

export type ArticleTransitionResult =
  | { ok: true; article: KnowledgeArticleResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: ArticleStatus }
  // THE exit condition: an unreviewed AI article cannot be published (route → 422 AI_REVIEW_REQUIRED).
  | { ok: false; reason: 'ai_review_required' }

export type ArticleTransitionAction = 'submit-for-review' | 'publish' | 'archive'

type TransitionInput = {
  organizationId: string
  articleId: string
  actorUserId: string
  expectedVersion: number
}

// Legal status edges: draft → in_review (submit); in_review → published (publish, AI-review gated);
// in_review | published → archived (archive).
const LEGAL_FROM: Record<ArticleTransitionAction, ArticleStatus[]> = {
  'submit-for-review': ['draft'],
  publish: ['in_review'],
  archive: ['in_review', 'published']
}

const TO_STATUS: Record<ArticleTransitionAction, ArticleStatus> = {
  'submit-for-review': 'in_review',
  publish: 'published',
  archive: 'archived'
}

async function transitionArticle(
  db: Kysely<Database>,
  action: ArticleTransitionAction,
  input: TransitionInput
): Promise<ArticleTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('knowledge.articles')
      .selectAll()
      .where('id', '=', input.articleId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as ArticleStatus
    if (!LEGAL_FROM[action].includes(from)) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    if (
      action === 'publish' &&
      !isArticlePublishable(
        current.source_type as ArticleSourceType,
        current.review_status as ArticleReviewStatus
      )
    ) {
      // ai-requires-review-before-publish: refuse to publish an unreviewed AI article, and audit.
      await audit(
        trx,
        input.organizationId,
        input.actorUserId,
        'knowledge.article.publish_refused',
        input.articleId
      )
      return { ok: false, reason: 'ai_review_required' }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('knowledge.articles')
      .set({ status: TO_STATUS[action], version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.articleId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `knowledge.article.${action === 'submit-for-review' ? 'submit' : action}`,
      input.articleId
    )
    await emitArticleEvent(trx, input.organizationId, input.articleId, newVersion, 'updated')
    return { ok: true, article: mapArticle(updated) }
  })
}

export function submitKnowledgeArticleForReview(
  db: Kysely<Database>,
  input: TransitionInput
): Promise<ArticleTransitionResult> {
  return transitionArticle(db, 'submit-for-review', input)
}

export function publishKnowledgeArticle(
  db: Kysely<Database>,
  input: TransitionInput
): Promise<ArticleTransitionResult> {
  return transitionArticle(db, 'publish', input)
}

export function archiveKnowledgeArticle(
  db: Kysely<Database>,
  input: TransitionInput
): Promise<ArticleTransitionResult> {
  return transitionArticle(db, 'archive', input)
}

export type ReviewDecision = 'approve' | 'reject'

export type ReviewKnowledgeArticleResult =
  | { ok: true; article: KnowledgeArticleResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export type ReviewKnowledgeArticleInput = TransitionInput & { decision: ReviewDecision }

/**
 * Records a human review verdict (approve|reject) on an article under OCC — the reviewer and time are
 * stamped. Approving an AI article is what unlocks publish; the review is a separate act from publish
 * so "모델 출력이 승인을 대체하지 않는다" is auditable (a named reviewer, not the model, approved it).
 */
export async function reviewKnowledgeArticle(
  db: Kysely<Database>,
  input: ReviewKnowledgeArticleInput
): Promise<ReviewKnowledgeArticleResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('knowledge.articles')
      .selectAll()
      .where('id', '=', input.articleId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('knowledge.articles')
      .set({
        review_status: input.decision === 'approve' ? 'approved' : 'rejected',
        reviewed_by: input.actorUserId,
        reviewed_at: sql`now()`,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.articleId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `knowledge.article.review.${input.decision}`,
      input.articleId
    )
    await emitArticleEvent(trx, input.organizationId, input.articleId, newVersion, 'updated')
    return { ok: true, article: mapArticle(updated) }
  })
}
