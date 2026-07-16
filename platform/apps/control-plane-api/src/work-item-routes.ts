import {
  createWorkItem,
  getWorkItem,
  listTeamWorkflow,
  listWorkItems,
  moveWorkItemState,
  updateWorkItem,
  type PieDatabase,
  type WorkItemPriority
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission, authorizeResourcePermission } from './route-authorization'

const WORK_ITEM_SCHEMA_ID = 'https://schemas.pielab.ai/resources/work-item.v1.schema.json'
const WORK_ITEM_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/work-item-create.v1.schema.json'
const WORK_ITEM_UPDATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/work-item-update.v1.schema.json'
const WORK_ITEM_MOVE_STATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/work-item-move-state.v1.schema.json'
const WORKFLOW_STATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/workflow-state.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type WorkItemRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function workItemEtag(version: number): string {
  return `"work-item-${version}"`
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"work-item-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export function registerWorkItemRoutes(app: FastifyInstance, deps: WorkItemRoutesDeps): void {
  // The read side of the board: a team's WorkItem Workflow states + the current
  // workflowVersion a client must echo in a move.
  app.get(
    '/v1/organizations/:organizationId/teams/:teamId/workflow-states',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, teamId } = request.params as {
        organizationId: string
        teamId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(teamId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'team.read'
        ))
      )
        return reply
      const workflow = await listTeamWorkflow(deps.db, organizationId, teamId)
      if (!workflow) return problem(reply, request, 404, 'NOT_FOUND', 'team not found')
      for (const state of workflow.states)
        assertResponse(deps.registry, WORKFLOW_STATE_SCHEMA_ID, state)
      return { items: workflow.states, workflowVersion: workflow.workflowVersion }
    }
  )

  app.get('/v1/organizations/:organizationId/work-items', async (request, reply) => {
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
        'work_item.read'
      ))
    )
      return reply
    const { projectId } = request.query as { projectId?: string }
    if (projectId !== undefined && !UUID_PATTERN.test(projectId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
    const items = await listWorkItems(deps.db, organizationId, projectId ? { projectId } : {})
    for (const item of items) assertResponse(deps.registry, WORK_ITEM_SCHEMA_ID, item)
    return { items, nextCursor: null }
  })

  app.post('/v1/organizations/:organizationId/work-items', async (request, reply) => {
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
      'work_item.create'
    )
    if (!authz) return reply
    if (!validates(deps.registry, WORK_ITEM_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid work item create request')
    const body = request.body as {
      teamId: string
      projectId?: string | null
      title: string
      description?: string | null
      stateId?: string | null
      priority?: WorkItemPriority
      assigneeId?: string | null
    }
    const result = await createWorkItem(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      teamId: body.teamId,
      projectId: body.projectId,
      title: body.title,
      description: body.description,
      stateId: body.stateId,
      priority: body.priority,
      assigneeId: body.assigneeId
    })
    if (!result.ok) {
      if (result.reason === 'team_not_found')
        return problem(reply, request, 409, 'NO_TEAM', 'team not found for work item')
      if (result.reason === 'project_not_found')
        return problem(reply, request, 409, 'NO_PROJECT', 'project not found for work item')
      return problem(reply, request, 422, 'INVALID_STATE', 'state is not in the team workflow')
    }
    assertResponse(deps.registry, WORK_ITEM_SCHEMA_ID, result.workItem)
    void reply
      .code(201)
      .header('etag', workItemEtag(result.workItem.version))
      .header('location', `/v1/organizations/${organizationId}/work-items/${result.workItem.id}`)
    return result.workItem
  })

  app.get('/v1/organizations/:organizationId/work-items/:workItemId', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, workItemId } = request.params as {
      organizationId: string
      workItemId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(workItemId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    // Resource-scoped: a per-work-item narrow/widen grant can override the role's
    // work_item.read.
    if (
      !(await authorizeResourcePermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        { resourceType: 'work_item', resourceId: workItemId },
        'work_item.read'
      ))
    )
      return reply
    const workItem = await getWorkItem(deps.db, organizationId, workItemId)
    if (!workItem) return problem(reply, request, 404, 'NOT_FOUND', 'work item not found')
    assertResponse(deps.registry, WORK_ITEM_SCHEMA_ID, workItem)
    void reply.header('etag', workItemEtag(workItem.version))
    return workItem
  })

  app.patch('/v1/organizations/:organizationId/work-items/:workItemId', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, workItemId } = request.params as {
      organizationId: string
      workItemId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(workItemId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'work_item.update'
      ))
    )
      return reply
    const expectedVersion = ifMatchVersion(request)
    if (expectedVersion === null)
      return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
    if (!validates(deps.registry, WORK_ITEM_UPDATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid work item update request')
    const patch = request.body as {
      title?: string
      description?: string | null
      priority?: WorkItemPriority
      assigneeId?: string | null
      projectId?: string | null
      stateId?: string
    }
    const result = await updateWorkItem(deps.db, {
      organizationId,
      workItemId,
      actorUserId: principal.subject,
      expectedVersion,
      patch
    })
    if (!result.ok) {
      if (result.reason === 'not_found')
        return problem(reply, request, 404, 'NOT_FOUND', 'work item not found')
      if (result.reason === 'project_not_found')
        return problem(reply, request, 409, 'NO_PROJECT', 'project not found for work item')
      if (result.reason === 'state_change_requires_move')
        return problem(reply, request, 409, 'USE_MOVE_STATE', 'state changes must use :move-state')
      return problem(reply, request, 412, 'PRECONDITION_FAILED', 'work item version conflict')
    }
    assertResponse(deps.registry, WORK_ITEM_SCHEMA_ID, result.workItem)
    void reply.header('etag', workItemEtag(result.workItem.version))
    return result.workItem
  })

  // AIP-style custom method. find-my-way cannot parse a param immediately followed
  // by a literal ':' suffix, so the whole `{workItemId}:move-state` token is one
  // param split here; the URL a client sees is still `.../work-items/{id}:move-state`.
  app.post('/v1/organizations/:organizationId/work-items/:moveTarget', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, moveTarget } = request.params as {
      organizationId: string
      moveTarget: string
    }
    const colon = moveTarget.lastIndexOf(':')
    const workItemId = colon === -1 ? moveTarget : moveTarget.slice(0, colon)
    const action = colon === -1 ? '' : moveTarget.slice(colon + 1)
    if (action !== 'move-state')
      return problem(reply, request, 404, 'NOT_FOUND', 'unknown work item action')
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(workItemId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'work_item.update'
    )
    if (!authz) return reply
    if (!validates(deps.registry, WORK_ITEM_MOVE_STATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid move-state request')
    const body = request.body as {
      fromStateId: string
      toStateId: string
      workflowVersion: number
      expectedVersion: number
    }
    const result = await moveWorkItemState(deps.db, {
      organizationId,
      workItemId,
      actorUserId: authz.userId ?? organizationId,
      fromStateId: body.fromStateId,
      toStateId: body.toStateId,
      workflowVersion: body.workflowVersion,
      expectedVersion: body.expectedVersion
    })
    if (!result.ok) {
      if (result.reason === 'not_found')
        return problem(reply, request, 404, 'NOT_FOUND', 'work item not found')
      if (result.reason === 'invalid_to_state')
        return problem(
          reply,
          request,
          422,
          'INVALID_TRANSITION',
          'target state is not in the workflow'
        )
      // version, workflowVersion, or fromState is stale — one precondition surface.
      return problem(
        reply,
        request,
        412,
        'PRECONDITION_FAILED',
        'work item move precondition failed'
      )
    }
    assertResponse(deps.registry, WORK_ITEM_SCHEMA_ID, result.workItem)
    void reply.header('etag', workItemEtag(result.workItem.version))
    return result.workItem
  })
}
