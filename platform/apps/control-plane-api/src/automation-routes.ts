import {
  approveRunbookExecution,
  claimWorkQueueItem,
  completeRunbookExecution,
  createRunbook,
  createRunbookExecution,
  createWorkQueueItem,
  getRunbook,
  getRunbookExecution,
  getWorkQueueItem,
  listRunbookExecutions,
  listRunbooks,
  listWorkQueueItems,
  rejectRunbookExecution,
  rollbackRunbookExecution,
  runRunbookExecution,
  transitionWorkQueueItem,
  updateRunbook,
  type PieDatabase,
  type RunbookExecutionResource,
  type RunbookExecutionTransitionResult,
  type RunbookTargetKind,
  type WorkQueuePriority,
  type WorkQueueStatus,
  type WorkQueueTransitionResult
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const SCHEMA = {
  runbook: 'https://schemas.pielab.ai/resources/runbook.v1.schema.json',
  runbookCreate: 'https://schemas.pielab.ai/resources/runbook-create.v1.schema.json',
  runbookUpdate: 'https://schemas.pielab.ai/resources/runbook-update.v1.schema.json',
  execution: 'https://schemas.pielab.ai/resources/runbook-execution.v1.schema.json',
  executionCreate: 'https://schemas.pielab.ai/resources/runbook-execution-create.v1.schema.json',
  executionComplete:
    'https://schemas.pielab.ai/resources/runbook-execution-complete.v1.schema.json',
  workQueueItem: 'https://schemas.pielab.ai/resources/work-queue-item.v1.schema.json',
  workQueueItemCreate: 'https://schemas.pielab.ai/resources/work-queue-item-create.v1.schema.json',
  workQueueItemTransition:
    'https://schemas.pielab.ai/resources/work-queue-item-transition.v1.schema.json'
} as const

const RUNBOOK_MANAGE = 'automation.runbook.manage'
const RUNBOOK_APPROVE = 'automation.runbook.approve'
const RUNBOOK_RUN = 'automation.runbook.run'
const WORKQUEUE_READ = 'automation.workqueue.read'
const WORKQUEUE_MANAGE = 'automation.workqueue.manage'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AutomationRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

// Splits `<id>:<action>` (custom method), mirroring qa / change-request action routes.
function parseTarget(target: string): { id: string; action: string } {
  const colon = target.lastIndexOf(':')
  return {
    id: colon === -1 ? target : target.slice(0, colon),
    action: colon === -1 ? '' : target.slice(colon + 1)
  }
}

async function guard(
  deps: AutomationRoutesDeps,
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

export function registerAutomationRoutes(app: FastifyInstance, deps: AutomationRoutesDeps): void {
  registerRunbookRoutes(app, deps)
  registerExecutionRoutes(app, deps)
  registerWorkQueueRoutes(app, deps)
}

// === runbooks ===
function registerRunbookRoutes(app: FastifyInstance, deps: AutomationRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/runbooks', (request, reply) =>
    createRunbookHandler(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/runbooks', async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }
    const auth = await guard(deps, app, request, reply, organizationId, RUNBOOK_RUN)
    if (!auth) return reply
    const { cursor } = request.query as { cursor?: string }
    const page = await listRunbooks(deps.db, organizationId, { cursor: cursor ?? null })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.runbook, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
  app.get('/v1/organizations/:organizationId/runbooks/:runbookId', async (request, reply) => {
    const { organizationId, runbookId } = request.params as {
      organizationId: string
      runbookId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, RUNBOOK_RUN)
    if (!auth) return reply
    if (!UUID_PATTERN.test(runbookId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const runbook = await getRunbook(deps.db, organizationId, runbookId)
    if (!runbook) return problem(reply, request, 404, 'NOT_FOUND', 'runbook not found')
    assertResponse(deps.registry, SCHEMA.runbook, runbook)
    void reply.header('etag', etag('runbook', runbook.version))
    return runbook
  })
  app.patch('/v1/organizations/:organizationId/runbooks/:runbookId', (request, reply) =>
    updateRunbookHandler(app, deps, request, reply)
  )
}

async function createRunbookHandler(
  app: FastifyInstance,
  deps: AutomationRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId } = request.params as { organizationId: string }
  const auth = await guard(deps, app, request, reply, organizationId, RUNBOOK_MANAGE)
  if (!auth) return reply
  if (!validates(deps.registry, SCHEMA.runbookCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid runbook create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/runbooks'
    },
    request.body
  )
  if (!gate) return reply
  const body = request.body as {
    name: string
    description?: string
    steps?: unknown[]
    targetKind: RunbookTargetKind
    requiresApproval?: boolean
  }
  if (gate.priorResourceId) {
    const existing = await getRunbook(deps.db, organizationId, gate.priorResourceId)
    if (existing) {
      assertResponse(deps.registry, SCHEMA.runbook, existing)
      void reply.code(201).header('etag', etag('runbook', existing.version))
      return existing
    }
  }
  const created = await createRunbook(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    name: body.name,
    description: body.description ?? null,
    steps: body.steps ?? [],
    targetKind: body.targetKind,
    requiresApproval: body.requiresApproval
  })
  await gate.complete(created.id)
  assertResponse(deps.registry, SCHEMA.runbook, created)
  void reply.code(201).header('etag', etag('runbook', created.version))
  return created
}

async function updateRunbookHandler(
  app: FastifyInstance,
  deps: AutomationRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, runbookId } = request.params as {
    organizationId: string
    runbookId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, RUNBOOK_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(runbookId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.runbookUpdate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid runbook update')
  const expectedVersion = ifMatchVersion(request, 'runbook')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    name?: string
    description?: string | null
    steps?: unknown[]
    targetKind?: RunbookTargetKind
    requiresApproval?: boolean
  }
  const result = await updateRunbook(deps.db, {
    organizationId,
    runbookId,
    actorUserId: auth.userId,
    expectedVersion,
    ...body
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'runbook not found')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'runbook modified concurrently')
  }
  assertResponse(deps.registry, SCHEMA.runbook, result.runbook)
  void reply.header('etag', etag('runbook', result.runbook.version))
  return result.runbook
}

// === runbook executions ===
function registerExecutionRoutes(app: FastifyInstance, deps: AutomationRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/runbooks/:runbookId/executions', (request, reply) =>
    createExecutionHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/runbooks/:runbookId/executions',
    async (request, reply) => {
      const { organizationId, runbookId } = request.params as {
        organizationId: string
        runbookId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, RUNBOOK_RUN)
      if (!auth) return reply
      if (!UUID_PATTERN.test(runbookId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const { cursor } = request.query as { cursor?: string }
      const page = await listRunbookExecutions(deps.db, organizationId, runbookId, {
        cursor: cursor ?? null
      })
      for (const item of page.items) assertResponse(deps.registry, SCHEMA.execution, item)
      return { items: page.items, nextCursor: page.nextCursor }
    }
  )
  app.get(
    '/v1/organizations/:organizationId/runbook-executions/:executionId',
    async (request, reply) => {
      const { organizationId, executionId } = request.params as {
        organizationId: string
        executionId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, RUNBOOK_RUN)
      if (!auth) return reply
      if (!UUID_PATTERN.test(executionId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const execution = await getRunbookExecution(deps.db, organizationId, executionId)
      if (!execution) return problem(reply, request, 404, 'NOT_FOUND', 'execution not found')
      assertResponse(deps.registry, SCHEMA.execution, execution)
      void reply.header('etag', etag('runbook-execution', execution.version))
      return execution
    }
  )
  app.post(
    '/v1/organizations/:organizationId/runbook-executions/:executionTarget',
    (request, reply) => transitionExecutionHandler(app, deps, request, reply)
  )
}

async function createExecutionHandler(
  app: FastifyInstance,
  deps: AutomationRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, runbookId } = request.params as {
    organizationId: string
    runbookId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, RUNBOOK_RUN)
  if (!auth) return reply
  if (!UUID_PATTERN.test(runbookId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.executionCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid execution create')
  const body = request.body as { targetId: string; targetKind: string }
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/runbooks/{runbookId}/executions'
    },
    request.body
  )
  if (!gate) return reply
  if (gate.priorResourceId) {
    const existing = await getRunbookExecution(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respondExecutionCreated(deps, reply, existing)
  }
  const result = await createRunbookExecution(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    runbookId,
    targetId: body.targetId,
    targetKind: body.targetKind
  })
  if (!result.ok) return problem(reply, request, 404, 'NOT_FOUND', 'runbook not found')
  await gate.complete(result.execution.id)
  return respondExecutionCreated(deps, reply, result.execution)
}

function respondExecutionCreated(
  deps: AutomationRoutesDeps,
  reply: FastifyReply,
  execution: RunbookExecutionResource
): RunbookExecutionResource {
  assertResponse(deps.registry, SCHEMA.execution, execution)
  void reply.code(201).header('etag', etag('runbook-execution', execution.version))
  return execution
}

type ExecutionAction = 'approve' | 'reject' | 'run' | 'complete' | 'rollback'

function isExecutionAction(action: string): action is ExecutionAction {
  return (
    action === 'approve' ||
    action === 'reject' ||
    action === 'run' ||
    action === 'complete' ||
    action === 'rollback'
  )
}

// approve/reject are the CRITICAL approval gate; run/complete/rollback are the operator run steps.
function permissionForExecutionAction(action: ExecutionAction): string {
  return action === 'approve' || action === 'reject' ? RUNBOOK_APPROVE : RUNBOOK_RUN
}

async function transitionExecutionHandler(
  app: FastifyInstance,
  deps: AutomationRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, executionTarget } = request.params as {
    organizationId: string
    executionTarget: string
  }
  const { id: executionId, action } = parseTarget(executionTarget)
  if (!isExecutionAction(action))
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown execution action')
  const auth = await guard(
    deps,
    app,
    request,
    reply,
    organizationId,
    permissionForExecutionAction(action)
  )
  if (!auth) return reply
  if (!UUID_PATTERN.test(executionId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (action === 'complete' && !validates(deps.registry, SCHEMA.executionComplete, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid execution complete')
  const expectedVersion = ifMatchVersion(request, 'runbook-execution')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const result = await runExecutionTransition(deps.db, action, {
    organizationId,
    executionId,
    actorUserId: auth.userId,
    expectedVersion,
    body: request.body
  })
  return respondExecutionTransition(deps, request, reply, action, result)
}

function runExecutionTransition(
  db: PieDatabase,
  action: ExecutionAction,
  input: {
    organizationId: string
    executionId: string
    actorUserId: string
    expectedVersion: number
    body: unknown
  }
): Promise<RunbookExecutionTransitionResult> {
  const base = {
    organizationId: input.organizationId,
    executionId: input.executionId,
    actorUserId: input.actorUserId,
    expectedVersion: input.expectedVersion
  }
  if (action === 'approve') return approveRunbookExecution(db, base)
  if (action === 'reject') return rejectRunbookExecution(db, base)
  if (action === 'run') return runRunbookExecution(db, base)
  if (action === 'rollback') return rollbackRunbookExecution(db, base)
  const completeResult = (input.body as { result?: unknown } | null)?.result
  return completeRunbookExecution(db, { ...base, result: completeResult })
}

function respondExecutionTransition(
  deps: AutomationRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  action: ExecutionAction,
  result: RunbookExecutionTransitionResult
): unknown {
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'execution not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'execution modified concurrently')
    if (result.reason === 'not_approved')
      // THE exit condition: no run before approval.
      return problem(
        reply,
        request,
        422,
        'RUNBOOK_NOT_APPROVED',
        `execution is ${result.status}; only an approved runbook execution may run`
      )
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${action} an execution in ${result.from}`
    )
  }
  assertResponse(deps.registry, SCHEMA.execution, result.execution)
  void reply.header('etag', etag('runbook-execution', result.execution.version))
  return result.execution
}

// === work queue ===
function registerWorkQueueRoutes(app: FastifyInstance, deps: AutomationRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/work-queue-items', (request, reply) =>
    createWorkQueueHandler(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/work-queue-items', async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }
    const auth = await guard(deps, app, request, reply, organizationId, WORKQUEUE_READ)
    if (!auth) return reply
    const { cursor, status } = request.query as { cursor?: string; status?: WorkQueueStatus }
    const page = await listWorkQueueItems(deps.db, organizationId, {
      cursor: cursor ?? null,
      ...(status ? { status } : {})
    })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.workQueueItem, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
  app.get('/v1/organizations/:organizationId/work-queue-items/:itemId', async (request, reply) => {
    const { organizationId, itemId } = request.params as {
      organizationId: string
      itemId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, WORKQUEUE_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(itemId)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const item = await getWorkQueueItem(deps.db, organizationId, itemId)
    if (!item) return problem(reply, request, 404, 'NOT_FOUND', 'work queue item not found')
    assertResponse(deps.registry, SCHEMA.workQueueItem, item)
    void reply.header('etag', etag('work-queue-item', item.version))
    return item
  })
  app.post('/v1/organizations/:organizationId/work-queue-items/:itemTarget', (request, reply) =>
    transitionWorkQueueHandler(app, deps, request, reply)
  )
}

async function createWorkQueueHandler(
  app: FastifyInstance,
  deps: AutomationRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId } = request.params as { organizationId: string }
  const auth = await guard(deps, app, request, reply, organizationId, WORKQUEUE_MANAGE)
  if (!auth) return reply
  if (!validates(deps.registry, SCHEMA.workQueueItemCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid work queue item create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/work-queue-items'
    },
    request.body
  )
  if (!gate) return reply
  if (gate.priorResourceId) {
    const existing = await getWorkQueueItem(deps.db, organizationId, gate.priorResourceId)
    if (existing) {
      assertResponse(deps.registry, SCHEMA.workQueueItem, existing)
      void reply.code(201).header('etag', etag('work-queue-item', existing.version))
      return existing
    }
  }
  const body = request.body as {
    title: string
    description?: string
    kind: string
    subjectId?: string
    priority?: WorkQueuePriority
  }
  const created = await createWorkQueueItem(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    title: body.title,
    description: body.description ?? null,
    kind: body.kind,
    subjectId: body.subjectId ?? null,
    priority: body.priority
  })
  await gate.complete(created.id)
  assertResponse(deps.registry, SCHEMA.workQueueItem, created)
  void reply.code(201).header('etag', etag('work-queue-item', created.version))
  return created
}

async function transitionWorkQueueHandler(
  app: FastifyInstance,
  deps: AutomationRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, itemTarget } = request.params as {
    organizationId: string
    itemTarget: string
  }
  const { id: itemId, action } = parseTarget(itemTarget)
  if (action !== 'claim' && action !== 'transition')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown work queue action')
  const auth = await guard(deps, app, request, reply, organizationId, WORKQUEUE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(itemId)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  const expectedVersion = ifMatchVersion(request, 'work-queue-item')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const base = { organizationId, itemId, actorUserId: auth.userId, expectedVersion }
  if (action === 'claim') {
    return respondWorkQueue(deps, request, reply, 'claim', await claimWorkQueueItem(deps.db, base))
  }
  if (!validates(deps.registry, SCHEMA.workQueueItemTransition, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid work queue transition')
  const { toStatus } = request.body as { toStatus: WorkQueueStatus }
  return respondWorkQueue(
    deps,
    request,
    reply,
    'transition',
    await transitionWorkQueueItem(deps.db, { ...base, toStatus })
  )
}

function respondWorkQueue(
  deps: AutomationRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  action: 'claim' | 'transition',
  result: WorkQueueTransitionResult
): unknown {
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'work queue item not found')
    if (result.reason === 'version_conflict')
      return problem(
        reply,
        request,
        409,
        'VERSION_CONFLICT',
        'work queue item modified concurrently'
      )
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${action} a work queue item in ${result.from}`
    )
  }
  assertResponse(deps.registry, SCHEMA.workQueueItem, result.item)
  void reply.header('etag', etag('work-queue-item', result.item.version))
  return result.item
}
