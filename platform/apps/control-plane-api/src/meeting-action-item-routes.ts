import {
  convertMeetingActionItemToWorkItem,
  getMeetingActionItem,
  listMeetingActionItems,
  reviewMeetingActionItem,
  updateMeetingActionItem,
  type MeetingActionItemResource,
  type PieDatabase,
  type WorkItemPriority
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency, type IdempotencyGate } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCHEMA = {
  actionItem: 'https://schemas.pielab.ai/resources/meeting-action-item.v1.schema.json',
  update: 'https://schemas.pielab.ai/resources/meeting-action-item-update.v1.schema.json',
  review: 'https://schemas.pielab.ai/resources/meeting-outcome-review.v1.schema.json',
  conversion:
    'https://schemas.pielab.ai/resources/meeting-action-work-item-conversion.v1.schema.json'
} as const
type Deps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function assertActionItem(
  registry: ContractSchemaRegistry,
  actionItem: MeetingActionItemResource
): void {
  if (!validates(registry, SCHEMA.actionItem, actionItem)) {
    throw new Error('meeting action item response violates its contract')
  }
}

async function authorize(
  app: FastifyInstance,
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  permission: 'meeting.read' | 'meeting.manage' | 'meeting.minutes.review' | 'work_item.create'
): Promise<{ userId: string } | null> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return null
  if (!UUID_PATTERN.test(organizationId)) {
    problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    return null
  }
  const result = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    permission
  )
  return result ? { userId: result.userId ?? organizationId } : null
}

function expectedVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"meeting-action-item-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

function parseTarget(target: string): { id: string; action: string } {
  const colon = target.lastIndexOf(':')
  return {
    id: colon < 0 ? target : target.slice(0, colon),
    action: colon < 0 ? '' : target.slice(colon + 1)
  }
}

async function replayActionItem(
  deps: Deps,
  reply: FastifyReply,
  organizationId: string,
  gate: IdempotencyGate
): Promise<MeetingActionItemResource | null> {
  if (!gate.priorResourceId) return null
  const prior = await getMeetingActionItem(deps.db, organizationId, gate.priorResourceId)
  if (!prior) return null
  assertActionItem(deps.registry, prior)
  void reply.header('etag', `"meeting-action-item-${prior.version}"`)
  return prior
}

function mutationFailure(
  reply: FastifyReply,
  request: FastifyRequest,
  reason:
    | 'not_found'
    | 'version_conflict'
    | 'evidence_not_found'
    | 'empty'
    | 'already_converted'
    | 'review_required'
    | 'team_not_found'
    | 'invalid_state'
    | 'project_not_found'
): FastifyReply {
  if (reason === 'not_found') {
    return problem(reply, request, 404, 'NOT_FOUND', 'action item not found')
  }
  if (reason === 'version_conflict') {
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'action item modified concurrently')
  }
  if (reason === 'already_converted') {
    return problem(reply, request, 409, 'ALREADY_CONVERTED', 'action item already has a work item')
  }
  if (reason === 'review_required') {
    return problem(reply, request, 422, 'REVIEW_REQUIRED', 'approve the action item first')
  }
  if (reason === 'team_not_found' || reason === 'project_not_found') {
    return problem(reply, request, 404, 'NOT_FOUND', reason.replaceAll('_', ' '))
  }
  if (reason === 'invalid_state') {
    return problem(reply, request, 409, 'INVALID_WORKFLOW', 'team has no valid default state')
  }
  if (reason === 'evidence_not_found') {
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'evidence is from another meeting')
  }
  return problem(reply, request, 400, 'VALIDATION_FAILED', 'action item task is required')
}

export function registerMeetingActionItemRoutes(app: FastifyInstance, deps: Deps): void {
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/action-items',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      if (!(await authorize(app, deps, request, reply, organizationId, 'meeting.read')))
        return reply
      if (!UUID_PATTERN.test(meetingId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      }
      const items = await listMeetingActionItems(deps.db, organizationId, meetingId)
      for (const item of items) assertActionItem(deps.registry, item)
      return { items }
    }
  )

  app.patch(
    '/v1/organizations/:organizationId/meeting-action-items/:actionItemId',
    async (request, reply) => {
      const { organizationId, actionItemId } = request.params as {
        organizationId: string
        actionItemId: string
      }
      const auth = await authorize(app, deps, request, reply, organizationId, 'meeting.manage')
      if (!auth) return reply
      if (!UUID_PATTERN.test(actionItemId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid action item id')
      }
      if (!validates(deps.registry, SCHEMA.update, request.body)) {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid action item update')
      }
      const version = expectedVersion(request)
      if (version === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: auth.userId,
          method: 'PATCH',
          route: '/v1/organizations/{organizationId}/meeting-action-items/{actionItemId}'
        },
        request.body
      )
      if (!gate) return reply
      const prior = await replayActionItem(deps, reply, organizationId, gate)
      if (prior) return prior
      const body = request.body as {
        task: string
        assigneeUserId?: string | null
        dueAt?: string | null
        priority?: WorkItemPriority
        evidenceSegmentId?: string | null
      }
      const result = await updateMeetingActionItem(deps.db, {
        organizationId,
        actionItemId,
        actorUserId: auth.userId,
        expectedVersion: version,
        task: body.task,
        assigneeUserId: body.assigneeUserId ?? null,
        dueAt: body.dueAt ?? null,
        priority: body.priority,
        evidenceSegmentId: body.evidenceSegmentId ?? null
      })
      if (!result.ok) {
        await gate.release()
        return mutationFailure(reply, request, result.reason)
      }
      await gate.complete(result.actionItem.id)
      assertActionItem(deps.registry, result.actionItem)
      void reply.header('etag', `"meeting-action-item-${result.actionItem.version}"`)
      return result.actionItem
    }
  )

  app.post(
    '/v1/organizations/:organizationId/meeting-action-items/:actionItemTarget',
    async (request, reply) => {
      const { organizationId, actionItemTarget } = request.params as {
        organizationId: string
        actionItemTarget: string
      }
      const { id: actionItemId, action } = parseTarget(actionItemTarget)
      if (action !== 'review' && action !== 'convert-to-work-item') {
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown action item operation')
      }
      const permission = action === 'review' ? 'meeting.minutes.review' : 'work_item.create'
      const auth = await authorize(app, deps, request, reply, organizationId, permission)
      if (!auth) return reply
      if (action === 'convert-to-work-item') {
        if (!(await authorize(app, deps, request, reply, organizationId, 'meeting.read'))) {
          return reply
        }
      }
      if (!UUID_PATTERN.test(actionItemId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid action item id')
      }
      const schema = action === 'review' ? SCHEMA.review : SCHEMA.conversion
      if (!validates(deps.registry, schema, request.body)) {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid action item operation')
      }
      const version = expectedVersion(request)
      if (version === null) {
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      }
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: auth.userId,
          method: 'POST',
          route: `/v1/organizations/{organizationId}/meeting-action-items/{actionItemId}:${action}`
        },
        request.body
      )
      if (!gate) return reply
      const prior = await replayActionItem(deps, reply, organizationId, gate)
      if (prior) return prior
      const result =
        action === 'review'
          ? await reviewMeetingActionItem(deps.db, {
              organizationId,
              actionItemId,
              actorUserId: auth.userId,
              expectedVersion: version,
              decision: (request.body as { decision: 'approve' | 'reject' }).decision
            })
          : await convertMeetingActionItemToWorkItem(deps.db, {
              organizationId,
              actionItemId,
              actorUserId: auth.userId,
              expectedVersion: version,
              teamId: (request.body as { teamId: string }).teamId,
              projectId: (request.body as { projectId?: string | null }).projectId ?? null
            })
      if (!result.ok) {
        await gate.release()
        return mutationFailure(reply, request, result.reason)
      }
      await gate.complete(result.actionItem.id)
      assertActionItem(deps.registry, result.actionItem)
      void reply.header('etag', `"meeting-action-item-${result.actionItem.version}"`)
      return result.actionItem
    }
  )
}
