import {
  createDefect,
  createDeliverable,
  createTestCase,
  getDefect,
  getDeliverable,
  getQaTraceability,
  getTestCase,
  listDefectsByProject,
  listDeliverablesByProject,
  listTestCasesByRequirement,
  transitionDefect,
  transitionDeliverable,
  transitionTestCase,
  updateDefect,
  updateDeliverable,
  updateTestCase,
  type DefectAction,
  type DefectResource,
  type DefectSeverity,
  type DeliverableAction,
  type DeliverableResource,
  type PieDatabase,
  type TestCaseAction,
  type TestCaseResource
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const SCHEMA = {
  deliverable: 'https://schemas.pielab.ai/resources/deliverable.v1.schema.json',
  deliverableCreate: 'https://schemas.pielab.ai/resources/deliverable-create.v1.schema.json',
  deliverableUpdate: 'https://schemas.pielab.ai/resources/deliverable-update.v1.schema.json',
  deliverableTransition:
    'https://schemas.pielab.ai/resources/deliverable-transition.v1.schema.json',
  testCase: 'https://schemas.pielab.ai/resources/test-case.v1.schema.json',
  testCaseCreate: 'https://schemas.pielab.ai/resources/test-case-create.v1.schema.json',
  testCaseUpdate: 'https://schemas.pielab.ai/resources/test-case-update.v1.schema.json',
  testCaseTransition: 'https://schemas.pielab.ai/resources/test-case-transition.v1.schema.json',
  defect: 'https://schemas.pielab.ai/resources/defect.v1.schema.json',
  defectCreate: 'https://schemas.pielab.ai/resources/defect-create.v1.schema.json',
  defectUpdate: 'https://schemas.pielab.ai/resources/defect-update.v1.schema.json',
  defectTransition: 'https://schemas.pielab.ai/resources/defect-transition.v1.schema.json',
  traceability: 'https://schemas.pielab.ai/resources/qa-traceability.v1.schema.json'
} as const

const QA_READ = 'project.qa.read'
const QA_MANAGE = 'project.qa.manage'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type QaRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function etag(prefix: string, version: number): string {
  return `"${prefix}-${version}"`
}

function ifMatchVersion(request: FastifyRequest, prefix: string): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? new RegExp(`^"${prefix}-(\\d+)"$`).exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

// Splits `<id>:<action>` (custom method), mirroring change-request / requirement action routes.
function parseTarget(target: string): { id: string; action: string } {
  const colon = target.lastIndexOf(':')
  return {
    id: colon === -1 ? target : target.slice(0, colon),
    action: colon === -1 ? '' : target.slice(colon + 1)
  }
}

async function guard(
  deps: QaRoutesDeps,
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

export function registerQaRoutes(app: FastifyInstance, deps: QaRoutesDeps): void {
  registerDeliverableRoutes(app, deps)
  registerTestCaseRoutes(app, deps)
  registerDefectRoutes(app, deps)
  registerTraceabilityRoute(app, deps)
}

// === deliverables ===
function registerDeliverableRoutes(app: FastifyInstance, deps: QaRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/projects/:projectId/deliverables', (request, reply) =>
    createDeliverableHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/deliverables',
    async (request, reply) => {
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, QA_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
      const { cursor } = request.query as { cursor?: string }
      const page = await listDeliverablesByProject(deps.db, organizationId, projectId, {
        cursor: cursor ?? null
      })
      for (const item of page.items) assertResponse(deps.registry, SCHEMA.deliverable, item)
      return { items: page.items, nextCursor: page.nextCursor }
    }
  )
  app.get(
    '/v1/organizations/:organizationId/deliverables/:deliverableId',
    async (request, reply) => {
      const { organizationId, deliverableId } = request.params as {
        organizationId: string
        deliverableId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, QA_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(deliverableId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const deliverable = await getDeliverable(deps.db, organizationId, deliverableId)
      if (!deliverable) return problem(reply, request, 404, 'NOT_FOUND', 'deliverable not found')
      assertResponse(deps.registry, SCHEMA.deliverable, deliverable)
      void reply.header('etag', etag('deliverable', deliverable.version))
      return deliverable
    }
  )
  app.patch('/v1/organizations/:organizationId/deliverables/:deliverableId', (request, reply) =>
    updateDeliverableHandler(app, deps, request, reply)
  )
  app.post('/v1/organizations/:organizationId/deliverables/:deliverableTarget', (request, reply) =>
    transitionDeliverableHandler(app, deps, request, reply)
  )
}

async function createDeliverableHandler(
  app: FastifyInstance,
  deps: QaRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, projectId } = request.params as {
    organizationId: string
    projectId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, QA_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(projectId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
  if (!validates(deps.registry, SCHEMA.deliverableCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid deliverable create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/projects/{projectId}/deliverables'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (deliverable: DeliverableResource): DeliverableResource => {
    assertResponse(deps.registry, SCHEMA.deliverable, deliverable)
    void reply
      .code(201)
      .header('etag', etag('deliverable', deliverable.version))
      .header('location', `/v1/organizations/${organizationId}/deliverables/${deliverable.id}`)
    return deliverable
  }
  if (gate.priorResourceId) {
    const existing = await getDeliverable(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const body = request.body as {
    name: string
    description?: string
    requirementId?: string
    wbsNodeId?: string
    dueDate?: string
  }
  const created = await createDeliverable(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    projectId,
    name: body.name,
    description: body.description ?? null,
    requirementId: body.requirementId ?? null,
    wbsNodeId: body.wbsNodeId ?? null,
    dueDate: body.dueDate ?? null
  })
  await gate.complete(created.id)
  return respond(created)
}

async function updateDeliverableHandler(
  app: FastifyInstance,
  deps: QaRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, deliverableId } = request.params as {
    organizationId: string
    deliverableId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, QA_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(deliverableId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.deliverableUpdate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid deliverable update')
  const expectedVersion = ifMatchVersion(request, 'deliverable')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    name?: string
    description?: string | null
    requirementId?: string | null
    wbsNodeId?: string | null
    dueDate?: string | null
  }
  const result = await updateDeliverable(deps.db, {
    organizationId,
    deliverableId,
    actorUserId: auth.userId,
    expectedVersion,
    ...body
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'deliverable not found')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'deliverable modified concurrently')
  }
  assertResponse(deps.registry, SCHEMA.deliverable, result.deliverable)
  void reply.header('etag', etag('deliverable', result.deliverable.version))
  return result.deliverable
}

function isDeliverableAction(action: string): action is DeliverableAction {
  return action === 'start' || action === 'submit' || action === 'accept' || action === 'reject'
}

async function transitionDeliverableHandler(
  app: FastifyInstance,
  deps: QaRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, deliverableTarget } = request.params as {
    organizationId: string
    deliverableTarget: string
  }
  const { id, action } = parseTarget(deliverableTarget)
  if (action !== 'transition')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown deliverable action')
  const auth = await guard(deps, app, request, reply, organizationId, QA_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(id)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.deliverableTransition, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transition')
  const expectedVersion = ifMatchVersion(request, 'deliverable')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const move = (request.body as { action?: string }).action ?? ''
  if (!isDeliverableAction(move))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid deliverable action')
  const result = await transitionDeliverable(deps.db, {
    organizationId,
    deliverableId: id,
    actorUserId: auth.userId,
    action: move,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'deliverable not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'deliverable modified concurrently')
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${move} a deliverable in ${result.from}`
    )
  }
  assertResponse(deps.registry, SCHEMA.deliverable, result.deliverable)
  void reply.header('etag', etag('deliverable', result.deliverable.version))
  return result.deliverable
}

// === test cases ===
function registerTestCaseRoutes(app: FastifyInstance, deps: QaRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/test-cases', (request, reply) =>
    createTestCaseHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/requirements/:requirementId/test-cases',
    async (request, reply) => {
      const { organizationId, requirementId } = request.params as {
        organizationId: string
        requirementId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, QA_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(requirementId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid requirementId')
      const { cursor } = request.query as { cursor?: string }
      const page = await listTestCasesByRequirement(deps.db, organizationId, requirementId, {
        cursor: cursor ?? null
      })
      for (const item of page.items) assertResponse(deps.registry, SCHEMA.testCase, item)
      return { items: page.items, nextCursor: page.nextCursor }
    }
  )
  app.get('/v1/organizations/:organizationId/test-cases/:testCaseId', async (request, reply) => {
    const { organizationId, testCaseId } = request.params as {
      organizationId: string
      testCaseId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, QA_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(testCaseId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const testCase = await getTestCase(deps.db, organizationId, testCaseId)
    if (!testCase) return problem(reply, request, 404, 'NOT_FOUND', 'test case not found')
    assertResponse(deps.registry, SCHEMA.testCase, testCase)
    void reply.header('etag', etag('test-case', testCase.version))
    return testCase
  })
  app.patch('/v1/organizations/:organizationId/test-cases/:testCaseId', (request, reply) =>
    updateTestCaseHandler(app, deps, request, reply)
  )
  app.post('/v1/organizations/:organizationId/test-cases/:testCaseTarget', (request, reply) =>
    transitionTestCaseHandler(app, deps, request, reply)
  )
}

async function createTestCaseHandler(
  app: FastifyInstance,
  deps: QaRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId } = request.params as { organizationId: string }
  const auth = await guard(deps, app, request, reply, organizationId, QA_MANAGE)
  if (!auth) return reply
  if (!validates(deps.registry, SCHEMA.testCaseCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid test case create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/test-cases'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (testCase: TestCaseResource): TestCaseResource => {
    assertResponse(deps.registry, SCHEMA.testCase, testCase)
    void reply
      .code(201)
      .header('etag', etag('test-case', testCase.version))
      .header('location', `/v1/organizations/${organizationId}/test-cases/${testCase.id}`)
    return testCase
  }
  if (gate.priorResourceId) {
    const existing = await getTestCase(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const body = request.body as {
    title: string
    steps?: string
    expected?: string
    requirementId?: string
    workItemId?: string
  }
  const created = await createTestCase(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    title: body.title,
    steps: body.steps ?? null,
    expected: body.expected ?? null,
    requirementId: body.requirementId ?? null,
    workItemId: body.workItemId ?? null
  })
  await gate.complete(created.id)
  return respond(created)
}

async function updateTestCaseHandler(
  app: FastifyInstance,
  deps: QaRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, testCaseId } = request.params as {
    organizationId: string
    testCaseId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, QA_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(testCaseId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.testCaseUpdate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid test case update')
  const expectedVersion = ifMatchVersion(request, 'test-case')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    title?: string
    steps?: string | null
    expected?: string | null
    requirementId?: string | null
    workItemId?: string | null
  }
  const result = await updateTestCase(deps.db, {
    organizationId,
    testCaseId,
    actorUserId: auth.userId,
    expectedVersion,
    ...body
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'test case not found')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'test case modified concurrently')
  }
  assertResponse(deps.registry, SCHEMA.testCase, result.testCase)
  void reply.header('etag', etag('test-case', result.testCase.version))
  return result.testCase
}

function isTestCaseAction(action: string): action is TestCaseAction {
  return action === 'ready' || action === 'pass' || action === 'fail' || action === 'block'
}

async function transitionTestCaseHandler(
  app: FastifyInstance,
  deps: QaRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, testCaseTarget } = request.params as {
    organizationId: string
    testCaseTarget: string
  }
  const { id, action } = parseTarget(testCaseTarget)
  if (action !== 'transition')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown test case action')
  const auth = await guard(deps, app, request, reply, organizationId, QA_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(id)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.testCaseTransition, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transition')
  const expectedVersion = ifMatchVersion(request, 'test-case')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const move = (request.body as { action?: string }).action ?? ''
  if (!isTestCaseAction(move))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid test case action')
  const result = await transitionTestCase(deps.db, {
    organizationId,
    testCaseId: id,
    actorUserId: auth.userId,
    action: move,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'test case not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'test case modified concurrently')
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${move} a test case in ${result.from}`
    )
  }
  assertResponse(deps.registry, SCHEMA.testCase, result.testCase)
  void reply.header('etag', etag('test-case', result.testCase.version))
  return result.testCase
}

// === defects ===
function registerDefectRoutes(app: FastifyInstance, deps: QaRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/projects/:projectId/defects', (request, reply) =>
    createDefectHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/defects',
    async (request, reply) => {
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, QA_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
      const { cursor } = request.query as { cursor?: string }
      const page = await listDefectsByProject(deps.db, organizationId, projectId, {
        cursor: cursor ?? null
      })
      for (const item of page.items) assertResponse(deps.registry, SCHEMA.defect, item)
      return { items: page.items, nextCursor: page.nextCursor }
    }
  )
  app.get('/v1/organizations/:organizationId/defects/:defectId', async (request, reply) => {
    const { organizationId, defectId } = request.params as {
      organizationId: string
      defectId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, QA_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(defectId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const defect = await getDefect(deps.db, organizationId, defectId)
    if (!defect) return problem(reply, request, 404, 'NOT_FOUND', 'defect not found')
    assertResponse(deps.registry, SCHEMA.defect, defect)
    void reply.header('etag', etag('defect', defect.version))
    return defect
  })
  app.patch('/v1/organizations/:organizationId/defects/:defectId', (request, reply) =>
    updateDefectHandler(app, deps, request, reply)
  )
  app.post('/v1/organizations/:organizationId/defects/:defectTarget', (request, reply) =>
    transitionDefectHandler(app, deps, request, reply)
  )
}

async function createDefectHandler(
  app: FastifyInstance,
  deps: QaRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, projectId } = request.params as {
    organizationId: string
    projectId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, QA_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(projectId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
  if (!validates(deps.registry, SCHEMA.defectCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid defect create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/projects/{projectId}/defects'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (defect: DefectResource): DefectResource => {
    assertResponse(deps.registry, SCHEMA.defect, defect)
    void reply
      .code(201)
      .header('etag', etag('defect', defect.version))
      .header('location', `/v1/organizations/${organizationId}/defects/${defect.id}`)
    return defect
  }
  if (gate.priorResourceId) {
    const existing = await getDefect(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const body = request.body as {
    title: string
    description?: string
    severity?: DefectSeverity
    testCaseId?: string
    workItemId?: string
    deliverableId?: string
  }
  const created = await createDefect(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    projectId,
    title: body.title,
    description: body.description ?? null,
    severity: body.severity,
    testCaseId: body.testCaseId ?? null,
    workItemId: body.workItemId ?? null,
    deliverableId: body.deliverableId ?? null
  })
  await gate.complete(created.id)
  return respond(created)
}

async function updateDefectHandler(
  app: FastifyInstance,
  deps: QaRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, defectId } = request.params as {
    organizationId: string
    defectId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, QA_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(defectId)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.defectUpdate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid defect update')
  const expectedVersion = ifMatchVersion(request, 'defect')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    title?: string
    description?: string | null
    severity?: DefectSeverity
    testCaseId?: string | null
    workItemId?: string | null
    deliverableId?: string | null
  }
  const result = await updateDefect(deps.db, {
    organizationId,
    defectId,
    actorUserId: auth.userId,
    expectedVersion,
    ...body
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'defect not found')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'defect modified concurrently')
  }
  assertResponse(deps.registry, SCHEMA.defect, result.defect)
  void reply.header('etag', etag('defect', result.defect.version))
  return result.defect
}

function isDefectAction(action: string): action is DefectAction {
  return (
    action === 'triage' ||
    action === 'start' ||
    action === 'resolve' ||
    action === 'close' ||
    action === 'reopen' ||
    action === 'wontfix'
  )
}

async function transitionDefectHandler(
  app: FastifyInstance,
  deps: QaRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, defectTarget } = request.params as {
    organizationId: string
    defectTarget: string
  }
  const { id, action } = parseTarget(defectTarget)
  if (action !== 'transition')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown defect action')
  const auth = await guard(deps, app, request, reply, organizationId, QA_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(id)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.defectTransition, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transition')
  const expectedVersion = ifMatchVersion(request, 'defect')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const move = (request.body as { action?: string }).action ?? ''
  if (!isDefectAction(move))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid defect action')
  const result = await transitionDefect(deps.db, {
    organizationId,
    defectId: id,
    actorUserId: auth.userId,
    action: move,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'defect not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'defect modified concurrently')
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${move} a defect in ${result.from}`
    )
  }
  assertResponse(deps.registry, SCHEMA.defect, result.defect)
  void reply.header('etag', etag('defect', result.defect.version))
  return result.defect
}

// === traceability read: requirement → its test_cases + deliverables + defects ===
function registerTraceabilityRoute(app: FastifyInstance, deps: QaRoutesDeps): void {
  app.get(
    '/v1/organizations/:organizationId/requirements/:requirementId/qa-traceability',
    async (request, reply) => {
      const { organizationId, requirementId } = request.params as {
        organizationId: string
        requirementId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, QA_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(requirementId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid requirementId')
      const trace = await getQaTraceability(deps.db, organizationId, requirementId)
      if (!trace) return problem(reply, request, 404, 'NOT_FOUND', 'requirement not found')
      assertResponse(deps.registry, SCHEMA.traceability, trace)
      return trace
    }
  )
}
