import {
  consumeQuota,
  getAiEntitlement,
  getAiEvaluation,
  getAiGuardEvent,
  getQuotaUsageById,
  listAiEntitlements,
  listAiEvaluations,
  listAiGuardEvents,
  recordAiEvaluation,
  recordAiGuardEvent,
  upsertAiEntitlement,
  type AiEvalVerdict,
  type AiGuardAction,
  type AiGuardKind,
  type AiQuotaPeriod,
  type AiResourceKind,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const SCHEMA = {
  entitlement: 'https://schemas.pielab.ai/resources/ai-entitlement.v1.schema.json',
  entitlementUpsert: 'https://schemas.pielab.ai/resources/ai-entitlement-upsert.v1.schema.json',
  consumeRequest: 'https://schemas.pielab.ai/resources/ai-consume-request.v1.schema.json',
  consumeResult: 'https://schemas.pielab.ai/resources/ai-consume-result.v1.schema.json',
  evaluation: 'https://schemas.pielab.ai/resources/ai-evaluation.v1.schema.json',
  evaluationCreate: 'https://schemas.pielab.ai/resources/ai-evaluation-create.v1.schema.json',
  guardEvent: 'https://schemas.pielab.ai/resources/ai-guard-event.v1.schema.json',
  guardEventCreate: 'https://schemas.pielab.ai/resources/ai-guard-event-create.v1.schema.json'
} as const

const ENTITLEMENT_MANAGE = 'ai.entitlement.manage'
const USAGE_CONSUME = 'ai.usage.consume'
const GOVERNANCE_READ = 'ai.governance.read'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AiGovernanceRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

async function guard(
  deps: AiGovernanceRoutesDeps,
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  permission: string
): Promise<{ userId: string } | null> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return null
  if (!UUID_PATTERN.test(organizationId)) {
    problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    return null
  }
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    permission
  )
  if (!authz) return null
  return { userId: authz.userId ?? organizationId }
}

export function registerAiGovernanceRoutes(
  app: FastifyInstance,
  deps: AiGovernanceRoutesDeps
): void {
  registerEntitlementRoutes(app, deps)
  registerConsumeRoute(app, deps)
  registerEvaluationRoutes(app, deps)
  registerGuardEventRoutes(app, deps)
}

// === entitlements (admin) ===
function registerEntitlementRoutes(app: FastifyInstance, deps: AiGovernanceRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/ai/entitlements', (request, reply) =>
    upsertEntitlementHandler(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/ai/entitlements', async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }
    const auth = await guard(deps, app, request, reply, organizationId, ENTITLEMENT_MANAGE)
    if (!auth) return reply
    const { cursor } = request.query as { cursor?: string }
    const page = await listAiEntitlements(deps.db, organizationId, { cursor: cursor ?? null })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.entitlement, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
}

async function upsertEntitlementHandler(
  app: FastifyInstance,
  deps: AiGovernanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId } = request.params as { organizationId: string }
  const auth = await guard(deps, app, request, reply, organizationId, ENTITLEMENT_MANAGE)
  if (!auth) return reply
  if (!validates(deps.registry, SCHEMA.entitlementUpsert, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid entitlement upsert')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/ai/entitlements'
    },
    request.body
  )
  if (!gate) return reply
  if (gate.priorResourceId) {
    const existing = await getAiEntitlement(deps.db, organizationId, gate.priorResourceId)
    if (existing) {
      assertResponse(deps.registry, SCHEMA.entitlement, existing)
      void reply.code(200)
      return existing
    }
  }
  const body = request.body as {
    resourceKind: AiResourceKind
    resourceKey: string
    allowed: boolean
    quotaLimit?: number | null
    quotaPeriod?: AiQuotaPeriod
  }
  const entitlement = await upsertAiEntitlement(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    resourceKind: body.resourceKind,
    resourceKey: body.resourceKey,
    allowed: body.allowed,
    quotaLimit: body.quotaLimit ?? null,
    quotaPeriod: body.quotaPeriod
  })
  await gate.complete(entitlement.id)
  assertResponse(deps.registry, SCHEMA.entitlement, entitlement)
  const created = entitlement.version === 1
  void reply.code(created ? 201 : 200)
  return entitlement
}

// === consume (the enforcement core) ===
function registerConsumeRoute(app: FastifyInstance, deps: AiGovernanceRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/ai/consume', (request, reply) =>
    consumeHandler(app, deps, request, reply)
  )
}

async function consumeHandler(
  app: FastifyInstance,
  deps: AiGovernanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId } = request.params as { organizationId: string }
  const auth = await guard(deps, app, request, reply, organizationId, USAGE_CONSUME)
  if (!auth) return reply
  if (!validates(deps.registry, SCHEMA.consumeRequest, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid consume request')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/ai/consume'
    },
    request.body
  )
  if (!gate) return reply
  // Replay of an identical consume returns the current counter WITHOUT a second increment.
  if (gate.priorResourceId) {
    const prior = await getQuotaUsageById(deps.db, organizationId, gate.priorResourceId)
    if (prior) {
      assertResponse(deps.registry, SCHEMA.consumeResult, prior)
      return prior
    }
  }
  const body = request.body as {
    resourceKind: AiResourceKind
    resourceKey: string
    periodKey: string
    amount: number
  }
  const result = await consumeQuota(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    resourceKind: body.resourceKind,
    resourceKey: body.resourceKey,
    periodKey: body.periodKey,
    amount: body.amount
  })
  if (!result.ok) {
    // Refused → release the reservation so an amended retry is not stuck IN_PROGRESS.
    await gate.release()
    if (result.reason === 'invalid_amount')
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'amount must be positive')
    if (result.reason === 'not_entitled')
      return problem(reply, request, 403, 'AI_NOT_ENTITLED', 'org is not entitled to this resource')
    return problem(
      reply,
      request,
      429,
      'AI_QUOTA_EXCEEDED',
      `quota exceeded: used ${result.used} + ${result.requested} > limit ${result.limit}`
    )
  }
  await gate.complete(result.usageId)
  assertResponse(deps.registry, SCHEMA.consumeResult, result.usage)
  return result.usage
}

// === evaluations ===
function registerEvaluationRoutes(app: FastifyInstance, deps: AiGovernanceRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/ai/evaluations', (request, reply) =>
    recordEvaluationHandler(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/ai/evaluations', async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }
    const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_READ)
    if (!auth) return reply
    const { cursor, subjectId } = request.query as { cursor?: string; subjectId?: string }
    const page = await listAiEvaluations(deps.db, organizationId, {
      cursor: cursor ?? null,
      ...(subjectId ? { subjectId } : {})
    })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.evaluation, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
}

async function recordEvaluationHandler(
  app: FastifyInstance,
  deps: AiGovernanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId } = request.params as { organizationId: string }
  const auth = await guard(deps, app, request, reply, organizationId, USAGE_CONSUME)
  if (!auth) return reply
  if (!validates(deps.registry, SCHEMA.evaluationCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid evaluation')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/ai/evaluations'
    },
    request.body
  )
  if (!gate) return reply
  if (gate.priorResourceId) {
    const existing = await getAiEvaluation(deps.db, organizationId, gate.priorResourceId)
    if (existing) {
      assertResponse(deps.registry, SCHEMA.evaluation, existing)
      void reply.code(201)
      return existing
    }
  }
  const body = request.body as {
    subjectId?: string
    modelKey: string
    metric: string
    score: number
    verdict: AiEvalVerdict
    notes?: string | null
    evaluatedBy?: string | null
  }
  const evaluation = await recordAiEvaluation(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    subjectId: body.subjectId ?? null,
    modelKey: body.modelKey,
    metric: body.metric,
    score: body.score,
    verdict: body.verdict,
    notes: body.notes ?? null,
    evaluatedBy: body.evaluatedBy ?? null
  })
  await gate.complete(evaluation.id)
  assertResponse(deps.registry, SCHEMA.evaluation, evaluation)
  void reply.code(201)
  return evaluation
}

// === guard events ===
function registerGuardEventRoutes(app: FastifyInstance, deps: AiGovernanceRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/ai/guard-events', (request, reply) =>
    recordGuardEventHandler(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/ai/guard-events', async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }
    const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_READ)
    if (!auth) return reply
    const { cursor, subjectId } = request.query as { cursor?: string; subjectId?: string }
    const page = await listAiGuardEvents(deps.db, organizationId, {
      cursor: cursor ?? null,
      ...(subjectId ? { subjectId } : {})
    })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.guardEvent, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
}

async function recordGuardEventHandler(
  app: FastifyInstance,
  deps: AiGovernanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId } = request.params as { organizationId: string }
  const auth = await guard(deps, app, request, reply, organizationId, USAGE_CONSUME)
  if (!auth) return reply
  if (!validates(deps.registry, SCHEMA.guardEventCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid guard event')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/ai/guard-events'
    },
    request.body
  )
  if (!gate) return reply
  if (gate.priorResourceId) {
    const existing = await getAiGuardEvent(deps.db, organizationId, gate.priorResourceId)
    if (existing) {
      assertResponse(deps.registry, SCHEMA.guardEvent, existing)
      void reply.code(201)
      return existing
    }
  }
  const body = request.body as {
    subjectId?: string
    guardKind: AiGuardKind
    action: AiGuardAction
    detail: string
    detectedBy: string
  }
  const guardEvent = await recordAiGuardEvent(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    subjectId: body.subjectId ?? null,
    guardKind: body.guardKind,
    action: body.action,
    detail: body.detail,
    detectedBy: body.detectedBy
  })
  await gate.complete(guardEvent.id)
  assertResponse(deps.registry, SCHEMA.guardEvent, guardEvent)
  void reply.code(201)
  return guardEvent
}
