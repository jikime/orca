import {
  createMeetingAgendaItemFromMessage,
  getMeeting,
  getMeetingAgendaItem,
  listMeetingAgendaItems,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const AGENDA_SCHEMA_ID = 'https://schemas.pielab.ai/resources/meeting-agenda-item.v1.schema.json'
const AGENDA_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/meeting-agenda-item-create.v1.schema.json'
const AGENDA_ROUTE = '/v1/organizations/{organizationId}/meetings/{meetingId}/agenda-items'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type MeetingAgendaRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function validates(registry: ContractSchemaRegistry, schemaId: string, value: unknown): boolean {
  const validate = registry.ajv.getSchema(schemaId)
  return !validate || validate(value) === true
}

function assertAgendaResponse(registry: ContractSchemaRegistry, value: unknown): void {
  if (!validates(registry, AGENDA_SCHEMA_ID, value)) {
    throw new Error('meeting agenda response violates its contract')
  }
}

export function registerMeetingAgendaRoutes(
  app: FastifyInstance,
  deps: MeetingAgendaRoutesDeps
): void {
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/agenda-items',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(meetingId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organization or meeting id')
      }
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'meeting.read'
      )
      if (!authz) return reply
      if (!(await getMeeting(deps.db, organizationId, meetingId))) {
        return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      }
      const items = await listMeetingAgendaItems(deps.db, organizationId, meetingId)
      for (const item of items) assertAgendaResponse(deps.registry, item)
      return { items }
    }
  )

  app.post(
    '/v1/organizations/:organizationId/meetings/:meetingId/agenda-items',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(meetingId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organization or meeting id')
      }
      if (!validates(deps.registry, AGENDA_CREATE_SCHEMA_ID, request.body)) {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid agenda item request')
      }
      const meetingAuthz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'meeting.manage'
      )
      if (!meetingAuthz?.userId) return reply
      const messageAuthz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'message.read'
      )
      if (!messageAuthz) return reply
      const body = request.body as { sourceChannelId: string; sourceMessageId: string }
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: principal.subject,
          method: 'POST',
          route: AGENDA_ROUTE
        },
        request.body
      )
      if (!gate) return reply
      if (gate.priorResourceId) {
        const existing = await getMeetingAgendaItem(deps.db, organizationId, gate.priorResourceId)
        if (existing) {
          assertAgendaResponse(deps.registry, existing)
          return existing
        }
      }
      const result = await createMeetingAgendaItemFromMessage(deps.db, {
        organizationId,
        meetingId,
        actorUserId: meetingAuthz.userId,
        sourceChannelId: body.sourceChannelId,
        sourceMessageId: body.sourceMessageId
      })
      if (!result.ok) {
        await gate.release()
        return problem(
          reply,
          request,
          404,
          result.reason === 'meeting_not_found' ? 'NOT_FOUND' : 'SOURCE_MESSAGE_NOT_FOUND',
          result.reason === 'meeting_not_found' ? 'meeting not found' : 'source message not found'
        )
      }
      await gate.complete(result.item.id)
      assertAgendaResponse(deps.registry, result.item)
      void reply.code(result.created ? 201 : 200)
      return result.item
    }
  )
}
