import {
  archiveKnowledgeArticle,
  authorizeSubjectForOrg,
  createKnowledgeArticle,
  getKnowledgeArticle,
  listKnowledgeArticles,
  publishKnowledgeArticle,
  reviewKnowledgeArticle,
  searchKnowledgeArticles,
  submitKnowledgeArticleForReview,
  updateKnowledgeArticle,
  type ArticleTransitionAction,
  type ArticleTransitionResult,
  type KnowledgeArticleResource,
  type PieDatabase,
  type ReviewDecision
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const ARTICLE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/knowledge-article.v1.schema.json'
const ARTICLE_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/knowledge-article-create.v1.schema.json'
const ARTICLE_UPDATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/knowledge-article-update.v1.schema.json'
const ARTICLE_REVIEW_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/knowledge-article-review.v1.schema.json'
const SEARCH_RESULT_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/knowledge-search-result.v1.schema.json'

const CREATE_ROUTE = '/v1/organizations/{organizationId}/knowledge/articles'
const ETAG_PREFIX = 'knowledge-article'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 50

// knowledge.read gates reading/searching; knowledge.manage gates authoring + status transitions;
// knowledge.review gates the review verdict; knowledge.customer_read is the customer-facing visibility
// gate the search filter re-evaluates per query.
const PERM_READ = 'knowledge.read'
const PERM_MANAGE = 'knowledge.manage'
const PERM_REVIEW = 'knowledge.review'
const PERM_CUSTOMER_READ = 'knowledge.customer_read'

export type KnowledgeRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

function problem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  title: string
): FastifyReply {
  sendProblem(
    reply,
    buildProblemDetails({
      status,
      title,
      code,
      requestId: requestCorrelationId(request),
      instance: request.url
    })
  )
  return reply
}

function validates(registry: ContractSchemaRegistry, schemaId: string, body: unknown): boolean {
  const validate = registry.ajv.getSchema(schemaId)
  return !validate || validate(body) === true
}

function assertResponse(registry: ContractSchemaRegistry, schemaId: string, body: unknown): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${schemaId}`)
  }
}

function articleEtag(version: number): string {
  return `"${ETAG_PREFIX}-${version}"`
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? new RegExp(`^"${ETAG_PREFIX}-(\\d+)"$`).exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export function registerKnowledgeRoutes(app: FastifyInstance, deps: KnowledgeRoutesDeps): void {
  registerCollection(app, deps)
  registerSearch(app, deps)
  registerItem(app, deps)
}

function registerCollection(app: FastifyInstance, deps: KnowledgeRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/knowledge/articles', (request, reply) =>
    handleCreate(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/knowledge/articles', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    if (
      !(await authorizeOrgPermission(deps.db, request, reply, principal, organizationId, PERM_READ))
    )
      return reply
    const { cursor, projectId } = request.query as { cursor?: string; projectId?: string }
    const page = await listKnowledgeArticles(deps.db, organizationId, {
      cursor: cursor ?? null,
      projectId: projectId ?? null
    })
    for (const item of page.items) assertResponse(deps.registry, ARTICLE_SCHEMA_ID, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
}

function registerSearch(app: FastifyInstance, deps: KnowledgeRoutesDeps): void {
  app.get('/v1/organizations/:organizationId/knowledge/search', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    if (
      !(await authorizeOrgPermission(deps.db, request, reply, principal, organizationId, PERM_READ))
    )
      return reply
    const query = request.query as { q?: string; limit?: string }
    if (typeof query.q !== 'string' || query.q.trim().length === 0)
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'q is required')
    const limit = query.limit
      ? Math.min(Math.max(Number(query.limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT)
      : DEFAULT_SEARCH_LIMIT
    // search-filters-at-query-time: the customer-facing permission is re-checked on EVERY search (a
    // non-throwing decision, not a 403), so revoking it changes the next result set with no reindex.
    const customer = await authorizeSubjectForOrg(
      deps.db,
      { issuer: principal.issuer, subject: principal.subject },
      organizationId,
      PERM_CUSTOMER_READ
    )
    const result = await searchKnowledgeArticles(deps.db, {
      organizationId,
      query: query.q,
      limit,
      canSeeCustomer: customer.decision.allowed
    })
    assertResponse(deps.registry, SEARCH_RESULT_SCHEMA_ID, result)
    return result
  })
}

async function handleCreate(
  app: FastifyInstance,
  deps: KnowledgeRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const { organizationId } = request.params as { organizationId: string }
  if (!UUID_PATTERN.test(organizationId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    PERM_MANAGE
  )
  if (!authz) return reply
  if (!validates(deps.registry, ARTICLE_CREATE_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid knowledge article create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    { organizationId, principalId: principal.subject, method: 'POST', route: CREATE_ROUTE },
    request.body
  )
  if (!gate) return reply
  const respond = (article: KnowledgeArticleResource): KnowledgeArticleResource => {
    assertResponse(deps.registry, ARTICLE_SCHEMA_ID, article)
    void reply
      .code(201)
      .header('etag', articleEtag(article.version))
      .header('location', `/v1/organizations/${organizationId}/knowledge/articles/${article.id}`)
    return article
  }
  if (gate.priorResourceId) {
    const existing = await getKnowledgeArticle(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const body = request.body as {
    title: string
    body: string
    visibility?: 'internal' | 'customer'
    sourceType?: 'manual' | 'ticket' | 'remote_session' | 'ai'
    sourceId?: string
    projectId?: string
  }
  const created = await createKnowledgeArticle(deps.db, {
    organizationId,
    actorUserId: authz.userId ?? organizationId,
    title: body.title,
    body: body.body,
    ...(body.visibility ? { visibility: body.visibility } : {}),
    ...(body.sourceType ? { sourceType: body.sourceType } : {}),
    sourceId: body.sourceId ?? null,
    projectId: body.projectId ?? null
  })
  await gate.complete(created.id)
  return respond(created)
}

function registerItem(app: FastifyInstance, deps: KnowledgeRoutesDeps): void {
  app.get(
    '/v1/organizations/:organizationId/knowledge/articles/:articleId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, articleId } = request.params as {
        organizationId: string
        articleId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(articleId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          PERM_READ
        ))
      )
        return reply
      const article = await getKnowledgeArticle(deps.db, organizationId, articleId)
      if (!article) return problem(reply, request, 404, 'NOT_FOUND', 'knowledge article not found')
      assertResponse(deps.registry, ARTICLE_SCHEMA_ID, article)
      void reply.header('etag', articleEtag(article.version))
      return article
    }
  )
  app.patch('/v1/organizations/:organizationId/knowledge/articles/:articleId', (request, reply) =>
    handleUpdate(app, deps, request, reply)
  )
  app.post(
    '/v1/organizations/:organizationId/knowledge/articles/:articleTarget',
    (request, reply) => handleTransition(app, deps, request, reply)
  )
}

async function handleUpdate(
  app: FastifyInstance,
  deps: KnowledgeRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const { organizationId, articleId } = request.params as {
    organizationId: string
    articleId: string
  }
  if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(articleId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    PERM_MANAGE
  )
  if (!authz) return reply
  if (!validates(deps.registry, ARTICLE_UPDATE_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid knowledge article update')
  const expectedVersion = ifMatchVersion(request)
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    title?: string
    body?: string
    visibility?: 'internal' | 'customer'
    projectId?: string | null
  }
  const result = await updateKnowledgeArticle(deps.db, {
    organizationId,
    articleId,
    actorUserId: authz.userId ?? organizationId,
    expectedVersion,
    ...body
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'knowledge article not found')
    if (result.reason === 'version_conflict')
      return problem(
        reply,
        request,
        409,
        'VERSION_CONFLICT',
        'knowledge article modified concurrently'
      )
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot edit a knowledge article in ${result.from}`
    )
  }
  assertResponse(deps.registry, ARTICLE_SCHEMA_ID, result.article)
  void reply.header('etag', articleEtag(result.article.version))
  return result.article
}

function parseAction(target: string): { articleId: string; action: string } {
  const colon = target.lastIndexOf(':')
  return {
    articleId: colon === -1 ? target : target.slice(0, colon),
    action: colon === -1 ? '' : target.slice(colon + 1)
  }
}

function isTransitionAction(action: string): action is ArticleTransitionAction {
  return action === 'submit-for-review' || action === 'publish' || action === 'archive'
}

async function handleTransition(
  app: FastifyInstance,
  deps: KnowledgeRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const { organizationId, articleTarget } = request.params as {
    organizationId: string
    articleTarget: string
  }
  const { articleId, action } = parseAction(articleTarget)
  if (action !== 'review' && !isTransitionAction(action))
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown knowledge article action')
  if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(articleId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  // review is the reviewer gate (knowledge.review); status transitions stay on knowledge.manage.
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    action === 'review' ? PERM_REVIEW : PERM_MANAGE
  )
  if (!authz) return reply
  const expectedVersion = ifMatchVersion(request)
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const actorUserId = authz.userId ?? organizationId
  if (action === 'review')
    return handleReview(deps, request, reply, {
      organizationId,
      articleId,
      actorUserId,
      expectedVersion
    })
  const result = await runTransition(deps.db, action, {
    organizationId,
    articleId,
    actorUserId,
    expectedVersion
  })
  return respondTransition(deps, request, reply, action, result)
}

async function handleReview(
  deps: KnowledgeRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  base: { organizationId: string; articleId: string; actorUserId: string; expectedVersion: number }
): Promise<unknown> {
  if (!validates(deps.registry, ARTICLE_REVIEW_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid knowledge article review')
  const { decision } = (request.body ?? {}) as { decision?: ReviewDecision }
  if (decision !== 'approve' && decision !== 'reject')
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'decision must be approve or reject')
  const result = await reviewKnowledgeArticle(deps.db, { ...base, decision })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'knowledge article not found')
    return problem(
      reply,
      request,
      409,
      'VERSION_CONFLICT',
      'knowledge article modified concurrently'
    )
  }
  assertResponse(deps.registry, ARTICLE_SCHEMA_ID, result.article)
  void reply.header('etag', articleEtag(result.article.version))
  return result.article
}

function runTransition(
  db: PieDatabase,
  action: ArticleTransitionAction,
  input: { organizationId: string; articleId: string; actorUserId: string; expectedVersion: number }
): Promise<ArticleTransitionResult> {
  if (action === 'submit-for-review') return submitKnowledgeArticleForReview(db, input)
  if (action === 'publish') return publishKnowledgeArticle(db, input)
  return archiveKnowledgeArticle(db, input)
}

function respondTransition(
  deps: KnowledgeRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  action: ArticleTransitionAction,
  result: ArticleTransitionResult
): unknown {
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'knowledge article not found')
    if (result.reason === 'version_conflict')
      return problem(
        reply,
        request,
        409,
        'VERSION_CONFLICT',
        'knowledge article modified concurrently'
      )
    if (result.reason === 'ai_review_required')
      // THE exit condition: an unreviewed AI article cannot be published — human review is required.
      return problem(
        reply,
        request,
        422,
        'AI_REVIEW_REQUIRED',
        'an AI-authored article must be human-reviewed and approved before publish'
      )
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${action} a knowledge article in ${result.from}`
    )
  }
  assertResponse(deps.registry, ARTICLE_SCHEMA_ID, result.article)
  void reply.header('etag', articleEtag(result.article.version))
  return result.article
}
