import {
  approveContract,
  createChangeOrder,
  createContract,
  createProjectFromContract,
  decideChangeOrder,
  getChangeOrder,
  getContract,
  getEffectiveScope,
  listContracts,
  rejectContract,
  submitContractForApproval,
  type ChangeOrderResource,
  type ContractResource,
  type PieDatabase,
  type ScopeItemInput
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const CONTRACT_SCHEMA_ID = 'https://schemas.pielab.ai/resources/crm-contract.v1.schema.json'
const CONTRACT_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/crm-contract-create.v1.schema.json'
const CHANGE_ORDER_SCHEMA_ID = 'https://schemas.pielab.ai/resources/crm-change-order.v1.schema.json'
const CHANGE_ORDER_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/crm-change-order-create.v1.schema.json'
const EFFECTIVE_SCOPE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/crm-effective-scope.v1.schema.json'
const PROJECT_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/crm-contract-project-create.v1.schema.json'
const PROJECT_LINK_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/crm-contract-project.v1.schema.json'

const CONTRACTS_ROUTE = '/v1/organizations/{organizationId}/crm/contracts'
const CHANGE_ORDERS_ROUTE =
  '/v1/organizations/{organizationId}/crm/contracts/{contractId}/change-orders'
const CREATE_PROJECT_ROUTE =
  '/v1/organizations/{organizationId}/crm/contracts/{contractId}:create-project'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CrmContractRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function contractEtag(version: number): string {
  return `"crm-contract-${version}"`
}

function changeOrderEtag(version: number): string {
  return `"crm-change-order-${version}"`
}

function ifMatchVersion(request: FastifyRequest, prefix: string): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? new RegExp(`^"${prefix}-(\\d+)"$`).exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export function registerCrmContractRoutes(app: FastifyInstance, deps: CrmContractRoutesDeps): void {
  registerContractCollection(app, deps)
  registerContractActions(app, deps)
  registerChangeOrderRoutes(app, deps)
}

function registerContractCollection(app: FastifyInstance, deps: CrmContractRoutesDeps): void {
  app.get('/v1/organizations/:organizationId/crm/contracts', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'crm.contract.read'
      ))
    )
      return reply
    const { accountId, cursor } = request.query as { accountId?: string; cursor?: string }
    const page = await listContracts(deps.db, organizationId, {
      ...(accountId ? { accountId } : {}),
      cursor: cursor ?? null
    })
    for (const item of page.items) assertResponse(deps.registry, CONTRACT_SCHEMA_ID, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })

  app.post('/v1/organizations/:organizationId/crm/contracts', async (request, reply) => {
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
      'crm.contract.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, CONTRACT_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid contract create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: CONTRACTS_ROUTE },
      request.body
    )
    if (!gate) return reply
    const respond = (contract: ContractResource, scopeItems?: unknown[]): ContractResource => {
      const wire = scopeItems ? { ...contract, scopeItems } : contract
      assertResponse(deps.registry, CONTRACT_SCHEMA_ID, wire)
      void reply
        .code(201)
        .header('etag', contractEtag(contract.version))
        .header('location', `/v1/organizations/${organizationId}/crm/contracts/${contract.id}`)
      return wire as ContractResource
    }
    if (gate.priorResourceId) {
      const existing = await getContract(deps.db, organizationId, gate.priorResourceId)
      if (existing) return respond(existing)
    }
    const body = request.body as {
      accountId: string
      title: string
      contractValue?: number | string
      effectiveStart?: string
      effectiveEnd?: string
      scopeItems?: ScopeItemInput[]
    }
    const result = await createContract(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      accountId: body.accountId,
      title: body.title,
      contractValue: body.contractValue,
      effectiveStart: body.effectiveStart ?? null,
      effectiveEnd: body.effectiveEnd ?? null,
      scopeItems: body.scopeItems
    })
    if (!result.ok) {
      await gate.release()
      return problem(reply, request, 404, 'NOT_FOUND', 'account not found')
    }
    await gate.complete(result.contract.id)
    return respond(result.contract, result.scopeItems)
  })

  app.get('/v1/organizations/:organizationId/crm/contracts/:contractId', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, contractId } = request.params as {
      organizationId: string
      contractId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(contractId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'crm.contract.read'
      ))
    )
      return reply
    const contract = await getContract(deps.db, organizationId, contractId)
    if (!contract) return problem(reply, request, 404, 'NOT_FOUND', 'contract not found')
    assertResponse(deps.registry, CONTRACT_SCHEMA_ID, contract)
    void reply.header('etag', contractEtag(contract.version))
    return contract
  })

  // Effective scope = base scope + APPROVED change-order deltas. The read that proves an
  // unapproved change order's scope is NOT part of the effective scope.
  app.get(
    '/v1/organizations/:organizationId/crm/contracts/:contractId/effective-scope',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, contractId } = request.params as {
        organizationId: string
        contractId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(contractId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'crm.contract.read'
        ))
      )
        return reply
      const scope = await getEffectiveScope(deps.db, organizationId, contractId)
      if (!scope) return problem(reply, request, 404, 'NOT_FOUND', 'contract not found')
      assertResponse(deps.registry, EFFECTIVE_SCOPE_SCHEMA_ID, scope)
      return scope
    }
  )
}

function registerContractActions(app: FastifyInstance, deps: CrmContractRoutesDeps): void {
  // Custom methods on a contract: :submit-for-approval, :approve, :reject (OCC), and the
  // execution gate :create-project. One param split on the last ':' (mirrors remote-session).
  app.post(
    '/v1/organizations/:organizationId/crm/contracts/:contractTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, contractTarget } = request.params as {
        organizationId: string
        contractTarget: string
      }
      const colon = contractTarget.lastIndexOf(':')
      const contractId = colon === -1 ? contractTarget : contractTarget.slice(0, colon)
      const action = colon === -1 ? '' : contractTarget.slice(colon + 1)
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(contractId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (action === 'create-project')
        return handleCreateProject(app, deps, request, reply, organizationId, contractId)
      if (action === 'submit-for-approval' || action === 'approve' || action === 'reject')
        return handleContractDecision(app, deps, request, reply, organizationId, contractId, action)
      return problem(reply, request, 404, 'NOT_FOUND', 'unknown contract action')
    }
  )
}

async function handleContractDecision(
  app: FastifyInstance,
  deps: CrmContractRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  contractId: string,
  action: 'submit-for-approval' | 'approve' | 'reject'
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  // Approve/reject is the CRITICAL approver gate (separate permission from manage) so a member
  // who can draft/submit a contract cannot approve it. Submit stays on manage.
  const permission =
    action === 'submit-for-approval' ? 'crm.contract.manage' : 'crm.contract.approve'
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    permission
  )
  if (!authz) return reply
  const expectedVersion = ifMatchVersion(request, 'crm-contract')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const actorUserId = authz.userId ?? organizationId
  const input = { organizationId, contractId, actorUserId, expectedVersion }
  const result =
    action === 'submit-for-approval'
      ? await submitContractForApproval(deps.db, input)
      : action === 'approve'
        ? await approveContract(deps.db, input)
        : await rejectContract(deps.db, input)
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'contract not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'contract was modified concurrently')
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${action} a contract in ${result.from}`
    )
  }
  assertResponse(deps.registry, CONTRACT_SCHEMA_ID, result.contract)
  void reply.header('etag', contractEtag(result.contract.version))
  return result.contract
}

async function handleCreateProject(
  app: FastifyInstance,
  deps: CrmContractRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  contractId: string
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    'crm.contract.manage'
  )
  if (!authz) return reply
  if (!validates(deps.registry, PROJECT_CREATE_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid create-project request')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    { organizationId, principalId: principal.subject, method: 'POST', route: CREATE_PROJECT_ROUTE },
    request.body ?? {}
  )
  if (!gate) return reply
  const body = (request.body ?? {}) as {
    projectName: string
    projectSummary?: string
    activate?: boolean
  }
  const result = await createProjectFromContract(deps.db, {
    organizationId,
    actorUserId: authz.userId ?? organizationId,
    contractId,
    projectName: body.projectName,
    projectSummary: body.projectSummary ?? null,
    ...(body.activate === undefined ? {} : { activate: body.activate })
  })
  if (!result.ok) {
    await gate.release()
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'contract not found')
    // THE exit condition: no execution before approval.
    return problem(
      reply,
      request,
      422,
      'CONTRACT_NOT_APPROVED',
      `contract is ${result.approvalStatus}; a project may only be created from an approved contract`
    )
  }
  await gate.complete(result.linkId)
  const link = {
    id: result.linkId,
    contractId,
    projectId: result.projectId,
    createdAt: result.createdAt
  }
  assertResponse(deps.registry, PROJECT_LINK_SCHEMA_ID, link)
  void reply
    .code(201)
    .header('location', `/v1/organizations/${organizationId}/projects/${result.projectId}`)
  return link
}

function registerChangeOrderRoutes(app: FastifyInstance, deps: CrmContractRoutesDeps): void {
  app.post(
    '/v1/organizations/:organizationId/crm/contracts/:contractId/change-orders',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, contractId } = request.params as {
        organizationId: string
        contractId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(contractId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'crm.contract.manage'
      )
      if (!authz) return reply
      if (!validates(deps.registry, CHANGE_ORDER_CREATE_SCHEMA_ID, request.body))
        return problem(
          reply,
          request,
          400,
          'VALIDATION_FAILED',
          'invalid change order create request'
        )
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: principal.subject,
          method: 'POST',
          route: CHANGE_ORDERS_ROUTE
        },
        request.body
      )
      if (!gate) return reply
      const respond = (
        changeOrder: ChangeOrderResource,
        scopeItems?: unknown[]
      ): ChangeOrderResource => {
        const wire = scopeItems ? { ...changeOrder, scopeItems } : changeOrder
        assertResponse(deps.registry, CHANGE_ORDER_SCHEMA_ID, wire)
        void reply
          .code(201)
          .header('etag', changeOrderEtag(changeOrder.version))
          .header(
            'location',
            `/v1/organizations/${organizationId}/crm/change-orders/${changeOrder.id}`
          )
        return wire as ChangeOrderResource
      }
      if (gate.priorResourceId) {
        const existing = await getChangeOrder(deps.db, organizationId, gate.priorResourceId)
        if (existing) return respond(existing)
      }
      const body = request.body as {
        title: string
        valueDelta?: number | string
        scopeItems?: (ScopeItemInput & { changeKind?: 'add' | 'remove' | 'modify' })[]
      }
      const result = await createChangeOrder(deps.db, {
        organizationId,
        actorUserId: authz.userId ?? organizationId,
        contractId,
        title: body.title,
        valueDelta: body.valueDelta,
        scopeItems: body.scopeItems
      })
      if (!result.ok) {
        await gate.release()
        return problem(reply, request, 404, 'NOT_FOUND', 'contract not found')
      }
      await gate.complete(result.changeOrder.id)
      return respond(result.changeOrder, result.scopeItems)
    }
  )

  app.get(
    '/v1/organizations/:organizationId/crm/change-orders/:changeOrderId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, changeOrderId } = request.params as {
        organizationId: string
        changeOrderId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(changeOrderId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'crm.contract.read'
        ))
      )
        return reply
      const changeOrder = await getChangeOrder(deps.db, organizationId, changeOrderId)
      if (!changeOrder) return problem(reply, request, 404, 'NOT_FOUND', 'change order not found')
      assertResponse(deps.registry, CHANGE_ORDER_SCHEMA_ID, changeOrder)
      void reply.header('etag', changeOrderEtag(changeOrder.version))
      return changeOrder
    }
  )

  // A change order's delta only merges into the effective scope once approved — approve/reject
  // is the customer-approver gate (crm.contract.approve), OCC-guarded.
  app.post(
    '/v1/organizations/:organizationId/crm/change-orders/:changeOrderTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, changeOrderTarget } = request.params as {
        organizationId: string
        changeOrderTarget: string
      }
      const colon = changeOrderTarget.lastIndexOf(':')
      const changeOrderId = colon === -1 ? changeOrderTarget : changeOrderTarget.slice(0, colon)
      const action = colon === -1 ? '' : changeOrderTarget.slice(colon + 1)
      if (action !== 'approve' && action !== 'reject')
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown change order action')
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(changeOrderId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'crm.contract.approve'
      )
      if (!authz) return reply
      const expectedVersion = ifMatchVersion(request, 'crm-change-order')
      if (expectedVersion === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      const result = await decideChangeOrder(deps.db, {
        organizationId,
        changeOrderId,
        actorUserId: authz.userId ?? organizationId,
        action,
        expectedVersion
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'change order not found')
        if (result.reason === 'version_conflict')
          return problem(
            reply,
            request,
            409,
            'VERSION_CONFLICT',
            'change order was modified concurrently'
          )
        return problem(
          reply,
          request,
          409,
          'ILLEGAL_TRANSITION',
          `cannot ${action} a change order in ${result.from}`
        )
      }
      assertResponse(deps.registry, CHANGE_ORDER_SCHEMA_ID, result.changeOrder)
      void reply.header('etag', changeOrderEtag(result.changeOrder.version))
      return result.changeOrder
    }
  )
}
