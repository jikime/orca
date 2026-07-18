import {
  captureScheduleBaseline,
  createMilestone,
  createWbsNode,
  getScheduleBaseline,
  getWbsNode,
  getWbsTree,
  listMilestones,
  listScheduleBaselines,
  moveWbsNode,
  transitionMilestone,
  updateWbsNode,
  type MilestoneResource,
  type MilestoneStatus,
  type PieDatabase,
  type WbsNodeResource,
  type WbsNodeType,
  type WbsNodeStatus
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

// R6 slice 4 routes: the planned-schedule backbone under a project — WBS tree (create/update/move
// + rolled-up tree read), milestones (create/list/:transition), and immutable schedule baselines
// (capture/list/read). project.plan.read gates reads; project.plan.manage gates mutations.

const WBS_NODE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/planning-wbs-node.v1.schema.json'
const WBS_NODE_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-wbs-node-create.v1.schema.json'
const WBS_NODE_UPDATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-wbs-node-update.v1.schema.json'
const WBS_NODE_MOVE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-wbs-node-move.v1.schema.json'
const WBS_TREE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/planning-wbs-tree.v1.schema.json'
const MILESTONE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/planning-milestone.v1.schema.json'
const MILESTONE_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-milestone-create.v1.schema.json'
const MILESTONE_TRANSITION_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-milestone-transition.v1.schema.json'
const BASELINE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-schedule-baseline.v1.schema.json'
const BASELINE_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-schedule-baseline-create.v1.schema.json'
const BASELINE_DETAIL_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-baseline-detail.v1.schema.json'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PlanningRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

export function registerPlanningRoutes(app: FastifyInstance, deps: PlanningRoutesDeps): void {
  registerWbsRoutes(app, deps)
  registerMilestoneRoutes(app, deps)
  registerBaselineRoutes(app, deps)
}

function registerWbsRoutes(app: FastifyInstance, deps: PlanningRoutesDeps): void {
  const wbsRoute = '/v1/organizations/{organizationId}/projects/{projectId}/wbs'

  app.get('/v1/organizations/:organizationId/projects/:projectId/wbs', async (request, reply) => {
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
        'project.plan.read'
      ))
    )
      return reply
    const items = await getWbsTree(deps.db, organizationId, projectId)
    const tree = { items }
    assertResponse(deps.registry, WBS_TREE_SCHEMA_ID, tree)
    return tree
  })

  app.post('/v1/organizations/:organizationId/projects/:projectId/wbs', async (request, reply) => {
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
      'project.plan.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, WBS_NODE_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid wbs node create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: wbsRoute },
      request.body
    )
    if (!gate) return reply
    const respond = (node: WbsNodeResource): WbsNodeResource => {
      assertResponse(deps.registry, WBS_NODE_SCHEMA_ID, node)
      void reply
        .code(201)
        .header('etag', etag('wbs-node', node.version))
        .header(
          'location',
          `/v1/organizations/${organizationId}/projects/${projectId}/wbs/${node.id}`
        )
      return node
    }
    if (gate.priorResourceId) {
      const existing = await getWbsNode(deps.db, organizationId, gate.priorResourceId)
      if (existing) return respond(existing)
    }
    const body = request.body as {
      parentId?: string
      wbsCode: string
      name: string
      nodeType?: WbsNodeType
      sortOrder?: number
      plannedStart?: string
      plannedEnd?: string
      plannedEffortHours?: number | string
      workItemId?: string
      status?: WbsNodeStatus
    }
    const result = await createWbsNode(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      projectId,
      parentId: body.parentId ?? null,
      wbsCode: body.wbsCode,
      name: body.name,
      nodeType: body.nodeType,
      sortOrder: body.sortOrder,
      plannedStart: body.plannedStart ?? null,
      plannedEnd: body.plannedEnd ?? null,
      plannedEffortHours: body.plannedEffortHours ?? null,
      workItemId: body.workItemId ?? null,
      status: body.status
    })
    if (!result.ok) {
      await gate.release()
      if (result.reason === 'parent_not_found')
        return problem(reply, request, 404, 'NOT_FOUND', 'parent node not found in this project')
      return problem(
        reply,
        request,
        409,
        'DUPLICATE_CODE',
        `a wbs node with code ${body.wbsCode} already exists in this project`
      )
    }
    await gate.complete(result.node.id)
    return respond(result.node)
  })

  registerWbsNodeActions(app, deps)
}

function registerWbsNodeActions(app: FastifyInstance, deps: PlanningRoutesDeps): void {
  // Custom methods on a node, split on the last ':' (mirrors crm-contract): :update and :move.
  app.post(
    '/v1/organizations/:organizationId/projects/:projectId/wbs/:nodeTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, projectId, nodeTarget } = request.params as {
        organizationId: string
        projectId: string
        nodeTarget: string
      }
      const colon = nodeTarget.lastIndexOf(':')
      const nodeId = colon === -1 ? nodeTarget : nodeTarget.slice(0, colon)
      const action = colon === -1 ? '' : nodeTarget.slice(colon + 1)
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(projectId) ||
        !UUID_PATTERN.test(nodeId)
      )
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (action === 'update')
        return handleWbsUpdate(app, deps, request, reply, organizationId, nodeId)
      if (action === 'move') return handleWbsMove(app, deps, request, reply, organizationId, nodeId)
      return problem(reply, request, 404, 'NOT_FOUND', 'unknown wbs node action')
    }
  )
}

async function handleWbsUpdate(
  app: FastifyInstance,
  deps: PlanningRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  nodeId: string
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    'project.plan.manage'
  )
  if (!authz) return reply
  if (!validates(deps.registry, WBS_NODE_UPDATE_SCHEMA_ID, request.body ?? {}))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid wbs node update request')
  const expectedVersion = ifMatchVersion(request, 'wbs-node')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    name?: string
    nodeType?: WbsNodeType
    plannedStart?: string | null
    plannedEnd?: string | null
    plannedEffortHours?: number | string | null
    workItemId?: string | null
    status?: WbsNodeStatus
  }
  const result = await updateWbsNode(deps.db, {
    organizationId,
    actorUserId: authz.userId ?? organizationId,
    nodeId,
    expectedVersion,
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.nodeType === undefined ? {} : { nodeType: body.nodeType }),
    ...(body.plannedStart === undefined ? {} : { plannedStart: body.plannedStart }),
    ...(body.plannedEnd === undefined ? {} : { plannedEnd: body.plannedEnd }),
    ...(body.plannedEffortHours === undefined
      ? {}
      : { plannedEffortHours: body.plannedEffortHours }),
    ...(body.workItemId === undefined ? {} : { workItemId: body.workItemId }),
    ...(body.status === undefined ? {} : { status: body.status })
  })
  if (!result.ok) return wbsMutationProblem(reply, request, result)
  assertResponse(deps.registry, WBS_NODE_SCHEMA_ID, result.node)
  void reply.header('etag', etag('wbs-node', result.node.version))
  return result.node
}

async function handleWbsMove(
  app: FastifyInstance,
  deps: PlanningRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  nodeId: string
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    'project.plan.manage'
  )
  if (!authz) return reply
  if (!validates(deps.registry, WBS_NODE_MOVE_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid wbs node move request')
  const expectedVersion = ifMatchVersion(request, 'wbs-node')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = request.body as { parentId: string | null; sortOrder?: number }
  const result = await moveWbsNode(deps.db, {
    organizationId,
    actorUserId: authz.userId ?? organizationId,
    nodeId,
    newParentId: body.parentId,
    ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'cycle')
      return problem(
        reply,
        request,
        409,
        'WBS_CYCLE',
        'the move would make the node its own ancestor'
      )
    if (result.reason === 'parent_not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'parent node not found in this project')
    return wbsMutationProblem(reply, request, result)
  }
  assertResponse(deps.registry, WBS_NODE_SCHEMA_ID, result.node)
  void reply.header('etag', etag('wbs-node', result.node.version))
  return result.node
}

function wbsMutationProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  result: { ok: false; reason: string }
): FastifyReply {
  if (result.reason === 'not_found')
    return problem(reply, request, 404, 'NOT_FOUND', 'wbs node not found')
  if (result.reason === 'version_conflict')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'wbs node was modified concurrently')
  return problem(reply, request, 409, 'ILLEGAL_TRANSITION', `cannot ${result.reason} the wbs node`)
}

function registerMilestoneRoutes(app: FastifyInstance, deps: PlanningRoutesDeps): void {
  const milestonesRoute = '/v1/organizations/{organizationId}/projects/{projectId}/milestones'

  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/milestones',
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
          'project.plan.read'
        ))
      )
        return reply
      const items = await listMilestones(deps.db, organizationId, projectId)
      for (const item of items) assertResponse(deps.registry, MILESTONE_SCHEMA_ID, item)
      return { items }
    }
  )

  app.post(
    '/v1/organizations/:organizationId/projects/:projectId/milestones',
    async (request, reply) => {
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
        'project.plan.manage'
      )
      if (!authz) return reply
      if (!validates(deps.registry, MILESTONE_CREATE_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid milestone create request')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        { organizationId, principalId: principal.subject, method: 'POST', route: milestonesRoute },
        request.body
      )
      if (!gate) return reply
      const respond = (milestone: MilestoneResource): MilestoneResource => {
        assertResponse(deps.registry, MILESTONE_SCHEMA_ID, milestone)
        void reply
          .code(201)
          .header('etag', etag('milestone', milestone.version))
          .header(
            'location',
            `/v1/organizations/${organizationId}/projects/${projectId}/milestones/${milestone.id}`
          )
        return milestone
      }
      if (gate.priorResourceId) {
        const existing = (await listMilestones(deps.db, organizationId, projectId)).find(
          (m) => m.id === gate.priorResourceId
        )
        if (existing) return respond(existing)
      }
      const body = request.body as {
        name: string
        targetDate: string
        wbsNodeId?: string
        status?: MilestoneStatus
      }
      const milestone = await createMilestone(deps.db, {
        organizationId,
        actorUserId: authz.userId ?? organizationId,
        projectId,
        name: body.name,
        targetDate: body.targetDate,
        wbsNodeId: body.wbsNodeId ?? null,
        status: body.status
      })
      await gate.complete(milestone.id)
      return respond(milestone)
    }
  )

  registerMilestoneActions(app, deps)
}

function registerMilestoneActions(app: FastifyInstance, deps: PlanningRoutesDeps): void {
  app.post(
    '/v1/organizations/:organizationId/projects/:projectId/milestones/:milestoneTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, milestoneTarget } = request.params as {
        organizationId: string
        milestoneTarget: string
      }
      const colon = milestoneTarget.lastIndexOf(':')
      const milestoneId = colon === -1 ? milestoneTarget : milestoneTarget.slice(0, colon)
      const action = colon === -1 ? '' : milestoneTarget.slice(colon + 1)
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(milestoneId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (action !== 'transition')
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown milestone action')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'project.plan.manage'
      )
      if (!authz) return reply
      if (!validates(deps.registry, MILESTONE_TRANSITION_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transition request')
      const expectedVersion = ifMatchVersion(request, 'milestone')
      if (expectedVersion === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      const body = request.body as { toStatus: MilestoneStatus }
      const result = await transitionMilestone(deps.db, {
        organizationId,
        actorUserId: authz.userId ?? organizationId,
        milestoneId,
        toStatus: body.toStatus,
        expectedVersion
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'milestone not found')
        return problem(
          reply,
          request,
          409,
          'VERSION_CONFLICT',
          'milestone was modified concurrently'
        )
      }
      assertResponse(deps.registry, MILESTONE_SCHEMA_ID, result.milestone)
      void reply.header('etag', etag('milestone', result.milestone.version))
      return result.milestone
    }
  )
}

function registerBaselineRoutes(app: FastifyInstance, deps: PlanningRoutesDeps): void {
  const baselinesRoute =
    '/v1/organizations/{organizationId}/projects/{projectId}/schedule-baselines'

  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/schedule-baselines',
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
          'project.plan.read'
        ))
      )
        return reply
      const items = await listScheduleBaselines(deps.db, organizationId, projectId)
      for (const item of items) assertResponse(deps.registry, BASELINE_SCHEMA_ID, item)
      return { items }
    }
  )

  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/schedule-baselines/:baselineId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, baselineId } = request.params as {
        organizationId: string
        baselineId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(baselineId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'project.plan.read'
        ))
      )
        return reply
      const detail = await getScheduleBaseline(deps.db, organizationId, baselineId)
      if (!detail) return problem(reply, request, 404, 'NOT_FOUND', 'baseline not found')
      assertResponse(deps.registry, BASELINE_DETAIL_SCHEMA_ID, detail)
      return detail
    }
  )

  app.post(
    '/v1/organizations/:organizationId/projects/:projectId/schedule-baselines',
    async (request, reply) => {
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
        'project.plan.manage'
      )
      if (!authz) return reply
      if (!validates(deps.registry, BASELINE_CREATE_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid baseline capture request')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        { organizationId, principalId: principal.subject, method: 'POST', route: baselinesRoute },
        request.body
      )
      if (!gate) return reply
      if (gate.priorResourceId) {
        const existing = await getScheduleBaseline(deps.db, organizationId, gate.priorResourceId)
        if (existing) {
          assertResponse(deps.registry, BASELINE_DETAIL_SCHEMA_ID, existing)
          void reply.code(201)
          return existing
        }
      }
      const body = request.body as { name: string }
      const detail = await captureScheduleBaseline(deps.db, {
        organizationId,
        actorUserId: authz.userId ?? organizationId,
        projectId,
        name: body.name
      })
      await gate.complete(detail.baseline.id)
      assertResponse(deps.registry, BASELINE_DETAIL_SCHEMA_ID, detail)
      void reply
        .code(201)
        .header('etag', etag('schedule-baseline', 1))
        .header(
          'location',
          `/v1/organizations/${organizationId}/projects/${projectId}/schedule-baselines/${detail.baseline.id}`
        )
      return detail
    }
  )
}
