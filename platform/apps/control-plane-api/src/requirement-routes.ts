import {
  createRequirement,
  getRequirement,
  getRequirementTraceability,
  linkRequirementWorkItem,
  listRequirementCoverage,
  recordRequirementAcceptance,
  transitionRequirement,
  unlinkRequirementWorkItem,
  type AcceptanceResult,
  type PieDatabase,
  type RequirementPriority,
  type RequirementResource
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const REQUIREMENT_SCHEMA_ID = 'https://schemas.pielab.ai/resources/requirement.v1.schema.json'
const REQUIREMENT_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/requirement-create.v1.schema.json'
const REQUIREMENT_TRANSITION_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/requirement-transition.v1.schema.json'
const LINK_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/requirement-work-item-link-create.v1.schema.json'
const LINK_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/requirement-work-item-link.v1.schema.json'
const ACCEPTANCE_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/requirement-acceptance-create.v1.schema.json'
const ACCEPTANCE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/requirement-acceptance.v1.schema.json'
const TRACEABILITY_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/requirement-traceability.v1.schema.json'
const COVERAGE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/requirement-coverage.v1.schema.json'

const REQUIREMENTS_ROUTE = '/v1/organizations/{organizationId}/requirements'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RequirementRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function requirementEtag(version: number): string {
  return `"requirement-${version}"`
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"requirement-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export function registerRequirementRoutes(app: FastifyInstance, deps: RequirementRoutesDeps): void {
  registerRequirementCollection(app, deps)
  registerRequirementReads(app, deps)
  registerRequirementActions(app, deps)
}

function registerRequirementCollection(app: FastifyInstance, deps: RequirementRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/requirements', async (request, reply) => {
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
      'requirement.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, REQUIREMENT_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid requirement create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: REQUIREMENTS_ROUTE },
      request.body
    )
    if (!gate) return reply
    const respond = (requirement: RequirementResource): RequirementResource => {
      assertResponse(deps.registry, REQUIREMENT_SCHEMA_ID, requirement)
      void reply
        .code(201)
        .header('etag', requirementEtag(requirement.version))
        .header('location', `/v1/organizations/${organizationId}/requirements/${requirement.id}`)
      return requirement
    }
    if (gate.priorResourceId) {
      const existing = await getRequirement(deps.db, organizationId, gate.priorResourceId)
      if (existing) return respond(existing)
    }
    const body = request.body as {
      projectId: string
      contractScopeItemId?: string
      code: string
      title: string
      description?: string
      priority?: RequirementPriority
      source?: string
    }
    const result = await createRequirement(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      projectId: body.projectId,
      contractScopeItemId: body.contractScopeItemId ?? null,
      code: body.code,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority,
      source: body.source ?? null
    })
    if (!result.ok) {
      await gate.release()
      return problem(
        reply,
        request,
        409,
        'DUPLICATE_CODE',
        `a requirement with code ${body.code} already exists in this project`
      )
    }
    await gate.complete(result.requirement.id)
    return respond(result.requirement)
  })
}

function registerRequirementReads(app: FastifyInstance, deps: RequirementRoutesDeps): void {
  // Coverage list is a STATIC segment so it is matched ahead of the :requirementId param route.
  app.get('/v1/organizations/:organizationId/requirements/coverage', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    const { projectId, cursor } = request.query as { projectId?: string; cursor?: string }
    if (!UUID_PATTERN.test(organizationId) || !projectId || !UUID_PATTERN.test(projectId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'projectId query is required')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'requirement.read'
      ))
    )
      return reply
    const page = await listRequirementCoverage(deps.db, organizationId, projectId, {
      cursor: cursor ?? null
    })
    for (const item of page.items) assertResponse(deps.registry, COVERAGE_SCHEMA_ID, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })

  app.get(
    '/v1/organizations/:organizationId/requirements/:requirementId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, requirementId } = request.params as {
        organizationId: string
        requirementId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(requirementId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'requirement.read'
        ))
      )
        return reply
      const requirement = await getRequirement(deps.db, organizationId, requirementId)
      if (!requirement) return problem(reply, request, 404, 'NOT_FOUND', 'requirement not found')
      assertResponse(deps.registry, REQUIREMENT_SCHEMA_ID, requirement)
      void reply.header('etag', requirementEtag(requirement.version))
      return requirement
    }
  )

  // The full traceability chain: requirement → scope → work items → code/test/artifact evidence →
  // acceptance, with the coverage/gap summary.
  app.get(
    '/v1/organizations/:organizationId/requirements/:requirementId/traceability',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, requirementId } = request.params as {
        organizationId: string
        requirementId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(requirementId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'requirement.read'
        ))
      )
        return reply
      const trace = await getRequirementTraceability(deps.db, organizationId, requirementId)
      if (!trace) return problem(reply, request, 404, 'NOT_FOUND', 'requirement not found')
      assertResponse(deps.registry, TRACEABILITY_SCHEMA_ID, trace)
      return trace
    }
  )
}

function registerRequirementActions(app: FastifyInstance, deps: RequirementRoutesDeps): void {
  // Custom methods on a requirement, split on the last ':' (mirrors crm-contract). :transition and
  // link/unlink take requirement.manage; :accept/:reject are gated behind the separate
  // requirement.accept permission (like contract approve) so a manager who can draft cannot accept.
  app.post(
    '/v1/organizations/:organizationId/requirements/:requirementTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, requirementTarget } = request.params as {
        organizationId: string
        requirementTarget: string
      }
      const colon = requirementTarget.lastIndexOf(':')
      const requirementId = colon === -1 ? requirementTarget : requirementTarget.slice(0, colon)
      const action = colon === -1 ? '' : requirementTarget.slice(colon + 1)
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(requirementId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (action === 'transition')
        return handleTransition(app, deps, request, reply, organizationId, requirementId)
      if (action === 'accept' || action === 'reject')
        return handleAcceptance(app, deps, request, reply, organizationId, requirementId, action)
      if (action === 'link-work-item' || action === 'unlink-work-item')
        return handleLink(app, deps, request, reply, organizationId, requirementId, action)
      return problem(reply, request, 404, 'NOT_FOUND', 'unknown requirement action')
    }
  )
}

async function handleTransition(
  app: FastifyInstance,
  deps: RequirementRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  requirementId: string
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    'requirement.manage'
  )
  if (!authz) return reply
  if (!validates(deps.registry, REQUIREMENT_TRANSITION_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transition request')
  const expectedVersion = ifMatchVersion(request)
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = request.body as { action: 'approve' | 'implement' | 'verify' }
  const result = await transitionRequirement(deps.db, {
    organizationId,
    requirementId,
    actorUserId: authz.userId ?? organizationId,
    action: body.action,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'requirement not found')
    if (result.reason === 'version_conflict')
      return problem(
        reply,
        request,
        409,
        'VERSION_CONFLICT',
        'requirement was modified concurrently'
      )
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${body.action} a requirement in ${result.from}`
    )
  }
  assertResponse(deps.registry, REQUIREMENT_SCHEMA_ID, result.requirement)
  void reply.header('etag', requirementEtag(result.requirement.version))
  return result.requirement
}

async function handleAcceptance(
  app: FastifyInstance,
  deps: RequirementRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  requirementId: string,
  action: 'accept' | 'reject'
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    'requirement.accept'
  )
  if (!authz) return reply
  if (!validates(deps.registry, ACCEPTANCE_CREATE_SCHEMA_ID, request.body ?? {}))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid acceptance request')
  const expectedVersion = ifMatchVersion(request)
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    result?: AcceptanceResult
    notes?: string
    deliverableRef?: string
  }
  const result = await recordRequirementAcceptance(deps.db, {
    organizationId,
    requirementId,
    actorUserId: authz.userId ?? organizationId,
    decision: action,
    result: body.result,
    notes: body.notes ?? null,
    deliverableRef: body.deliverableRef ?? null,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'requirement not found')
    if (result.reason === 'version_conflict')
      return problem(
        reply,
        request,
        409,
        'VERSION_CONFLICT',
        'requirement was modified concurrently'
      )
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${action} a requirement in ${result.from}`
    )
  }
  assertResponse(deps.registry, ACCEPTANCE_SCHEMA_ID, result.acceptance)
  void reply.header('etag', requirementEtag(result.requirement.version))
  return { requirement: result.requirement, acceptance: result.acceptance }
}

async function handleLink(
  app: FastifyInstance,
  deps: RequirementRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  requirementId: string,
  action: 'link-work-item' | 'unlink-work-item'
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    'requirement.manage'
  )
  if (!authz) return reply
  if (!validates(deps.registry, LINK_CREATE_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid work-item link request')
  const body = request.body as { workItemId: string }
  const actorUserId = authz.userId ?? organizationId
  if (action === 'unlink-work-item') {
    const unlinked = await unlinkRequirementWorkItem(deps.db, {
      organizationId,
      actorUserId,
      requirementId,
      workItemId: body.workItemId
    })
    if (!unlinked.ok) {
      return problem(reply, request, 404, 'NOT_FOUND', unlinked.reason)
    }
    void reply.code(204)
    return reply
  }
  const linked = await linkRequirementWorkItem(deps.db, {
    organizationId,
    actorUserId,
    requirementId,
    workItemId: body.workItemId
  })
  if (!linked.ok) {
    if (linked.reason === 'requirement_not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'requirement not found')
    return problem(reply, request, 404, 'NOT_FOUND', 'work item not found')
  }
  const link = { id: linked.linkId, requirementId, workItemId: linked.workItemId }
  assertResponse(deps.registry, LINK_SCHEMA_ID, link)
  void reply.code(201)
  return link
}
