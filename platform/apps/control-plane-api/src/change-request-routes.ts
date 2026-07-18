import {
  applyChangeRequest,
  approveChangeRequest,
  createChangeRequest,
  getChangeRequest,
  listChangeRequestsByProject,
  rejectChangeRequest,
  submitChangeRequestForApproval,
  updateChangeRequest,
  type ChangeRequestAction,
  type ChangeRequestResource,
  type ChangeRequestTransitionResult,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const CHANGE_REQUEST_SCHEMA_ID = 'https://schemas.pielab.ai/resources/change-request.v1.schema.json'
const CHANGE_REQUEST_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/change-request-create.v1.schema.json'
const CHANGE_REQUEST_UPDATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/change-request-update.v1.schema.json'

const CREATE_ROUTE = '/v1/organizations/{organizationId}/projects/{projectId}/change-requests'
const ETAG_PREFIX = 'change-request'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ChangeRequestRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function assertResponse(registry: ContractSchemaRegistry, body: unknown): void {
  const validate = registry.ajv.getSchema(CHANGE_REQUEST_SCHEMA_ID)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${CHANGE_REQUEST_SCHEMA_ID}`)
  }
}

function changeRequestEtag(version: number): string {
  return `"${ETAG_PREFIX}-${version}"`
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? new RegExp(`^"${ETAG_PREFIX}-(\\d+)"$`).exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

// approve/reject are the CRITICAL customer-approval gate (approver-is-critical-perm); submit and
// apply stay on the standard requester permission. apply's status check is the execution limit.
function permissionForAction(action: ChangeRequestAction): string {
  return action === 'approve' || action === 'reject'
    ? 'project.change.approve'
    : 'project.change.request'
}

export function registerChangeRequestRoutes(
  app: FastifyInstance,
  deps: ChangeRequestRoutesDeps
): void {
  registerCollection(app, deps)
  registerItem(app, deps)
}

function registerCollection(app: FastifyInstance, deps: ChangeRequestRoutesDeps): void {
  app.post(
    '/v1/organizations/:organizationId/projects/:projectId/change-requests',
    (request, reply) => handleCreate(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/change-requests',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'project.read'
        ))
      )
        return reply
      const { cursor } = request.query as { cursor?: string }
      const page = await listChangeRequestsByProject(deps.db, organizationId, projectId, {
        cursor: cursor ?? null
      })
      for (const item of page.items) assertResponse(deps.registry, item)
      return { items: page.items, nextCursor: page.nextCursor }
    }
  )
}

async function handleCreate(
  app: FastifyInstance,
  deps: ChangeRequestRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const { organizationId, projectId } = request.params as {
    organizationId: string
    projectId: string
  }
  if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    'project.change.request'
  )
  if (!authz) return reply
  if (!validates(deps.registry, CHANGE_REQUEST_CREATE_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid change request create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    { organizationId, principalId: principal.subject, method: 'POST', route: CREATE_ROUTE },
    request.body
  )
  if (!gate) return reply
  const respond = (changeRequest: ChangeRequestResource): ChangeRequestResource => {
    assertResponse(deps.registry, changeRequest)
    void reply
      .code(201)
      .header('etag', changeRequestEtag(changeRequest.version))
      .header('location', `/v1/organizations/${organizationId}/change-requests/${changeRequest.id}`)
    return changeRequest
  }
  if (gate.priorResourceId) {
    const existing = await getChangeRequest(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const body = request.body as {
    title: string
    description?: string
    scopeDelta?: string
    scheduleDeltaDays?: number
    costDelta?: number | string
    wbsNodeId?: string
    requirementId?: string
  }
  const created = await createChangeRequest(deps.db, {
    organizationId,
    actorUserId: authz.userId ?? organizationId,
    projectId,
    title: body.title,
    description: body.description ?? null,
    scopeDelta: body.scopeDelta ?? null,
    scheduleDeltaDays: body.scheduleDeltaDays ?? null,
    costDelta: body.costDelta ?? null,
    wbsNodeId: body.wbsNodeId ?? null,
    requirementId: body.requirementId ?? null
  })
  await gate.complete(created.id)
  return respond(created)
}

function registerItem(app: FastifyInstance, deps: ChangeRequestRoutesDeps): void {
  app.get(
    '/v1/organizations/:organizationId/change-requests/:changeRequestId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, changeRequestId } = request.params as {
        organizationId: string
        changeRequestId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(changeRequestId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'project.read'
        ))
      )
        return reply
      const changeRequest = await getChangeRequest(deps.db, organizationId, changeRequestId)
      if (!changeRequest)
        return problem(reply, request, 404, 'NOT_FOUND', 'change request not found')
      assertResponse(deps.registry, changeRequest)
      void reply.header('etag', changeRequestEtag(changeRequest.version))
      return changeRequest
    }
  )
  app.patch(
    '/v1/organizations/:organizationId/change-requests/:changeRequestId',
    (request, reply) => handleUpdate(app, deps, request, reply)
  )
  app.post(
    '/v1/organizations/:organizationId/change-requests/:changeRequestTarget',
    (request, reply) => handleTransition(app, deps, request, reply)
  )
}

async function handleUpdate(
  app: FastifyInstance,
  deps: ChangeRequestRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const { organizationId, changeRequestId } = request.params as {
    organizationId: string
    changeRequestId: string
  }
  if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(changeRequestId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    'project.change.request'
  )
  if (!authz) return reply
  if (!validates(deps.registry, CHANGE_REQUEST_UPDATE_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid change request update')
  const expectedVersion = ifMatchVersion(request)
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    title?: string
    description?: string | null
    scopeDelta?: string | null
    scheduleDeltaDays?: number | null
    costDelta?: number | string | null
    wbsNodeId?: string | null
    requirementId?: string | null
  }
  const result = await updateChangeRequest(deps.db, {
    organizationId,
    changeRequestId,
    actorUserId: authz.userId ?? organizationId,
    expectedVersion,
    ...body
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'change request not found')
    if (result.reason === 'version_conflict')
      return problem(
        reply,
        request,
        409,
        'VERSION_CONFLICT',
        'change request modified concurrently'
      )
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot edit a change request in ${result.from}`
    )
  }
  assertResponse(deps.registry, result.changeRequest)
  void reply.header('etag', changeRequestEtag(result.changeRequest.version))
  return result.changeRequest
}

function parseAction(target: string): { changeRequestId: string; action: string } {
  const colon = target.lastIndexOf(':')
  return {
    changeRequestId: colon === -1 ? target : target.slice(0, colon),
    action: colon === -1 ? '' : target.slice(colon + 1)
  }
}

function isChangeRequestAction(action: string): action is ChangeRequestAction {
  return (
    action === 'submit-for-approval' ||
    action === 'approve' ||
    action === 'reject' ||
    action === 'apply'
  )
}

async function handleTransition(
  app: FastifyInstance,
  deps: ChangeRequestRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const { organizationId, changeRequestTarget } = request.params as {
    organizationId: string
    changeRequestTarget: string
  }
  const { changeRequestId, action } = parseAction(changeRequestTarget)
  if (!isChangeRequestAction(action))
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown change request action')
  if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(changeRequestId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    permissionForAction(action)
  )
  if (!authz) return reply
  const expectedVersion = ifMatchVersion(request)
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const input = {
    organizationId,
    changeRequestId,
    actorUserId: authz.userId ?? organizationId,
    expectedVersion
  }
  const result = await runTransition(deps.db, action, input)
  return respondTransition(deps, request, reply, action, result)
}

function runTransition(
  db: PieDatabase,
  action: ChangeRequestAction,
  input: {
    organizationId: string
    changeRequestId: string
    actorUserId: string
    expectedVersion: number
  }
): Promise<ChangeRequestTransitionResult> {
  if (action === 'submit-for-approval') return submitChangeRequestForApproval(db, input)
  if (action === 'approve') return approveChangeRequest(db, input)
  if (action === 'reject') return rejectChangeRequest(db, input)
  return applyChangeRequest(db, input)
}

function respondTransition(
  deps: ChangeRequestRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  action: ChangeRequestAction,
  result: ChangeRequestTransitionResult
): unknown {
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'change request not found')
    if (result.reason === 'version_conflict')
      return problem(
        reply,
        request,
        409,
        'VERSION_CONFLICT',
        'change request modified concurrently'
      )
    if (result.reason === 'not_approved')
      // THE exit condition: no execution before approval.
      return problem(
        reply,
        request,
        422,
        'CHANGE_NOT_APPROVED',
        `change request is ${result.status}; only an approved change request may be applied`
      )
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${action} a change request in ${result.from}`
    )
  }
  assertResponse(deps.registry, result.changeRequest)
  void reply.header('etag', changeRequestEtag(result.changeRequest.version))
  return result.changeRequest
}
