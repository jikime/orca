import {
  beginMeetingCalendarSync,
  finishMeetingCalendarSync,
  getMeeting,
  listMeetingAttendeeEmails,
  listMeetingCalendarLinks,
  type MeetingCalendarProvider,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import type { MeetingCalendarService } from './meeting-calendar-service'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const LINK_SCHEMA = 'https://schemas.pielab.ai/resources/meeting-calendar-link.v1.schema.json'
const EXPORT_SCHEMA = 'https://schemas.pielab.ai/resources/meeting-calendar-export.v1.schema.json'
const PROVIDERS: MeetingCalendarProvider[] = ['google_workspace', 'microsoft_365']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Deps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  calendar?: MeetingCalendarService
}

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

function assertLink(deps: Deps, value: unknown): void {
  const validate = deps.registry.ajv.getSchema(LINK_SCHEMA)
  if (validate && validate(value) !== true) throw new Error('calendar link violates contract')
}

async function guard(
  app: FastifyInstance,
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: string
): Promise<{ organizationId: string; meetingId: string; userId: string } | null> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return null
  const { organizationId, meetingId } = request.params as {
    organizationId: string
    meetingId: string
  }
  if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(meetingId)) {
    problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    return null
  }
  const auth = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    permission
  )
  return auth?.userId ? { organizationId, meetingId, userId: auth.userId } : null
}

export function registerMeetingCalendarRoutes(app: FastifyInstance, deps: Deps): void {
  app.get(
    '/v1/organizations/:organizationId/meeting-calendar-providers',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId } = request.params as { organizationId: string }
      const auth = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'meeting.read'
      )
      if (!auth) return reply
      return { items: deps.calendar?.configuredProviders() ?? [] }
    }
  )

  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/calendar-exports',
    async (request, reply) => {
      const auth = await guard(app, deps, request, reply, 'meeting.read')
      if (!auth) return reply
      const items = await listMeetingCalendarLinks(deps.db, auth.organizationId, auth.meetingId)
      items.forEach((item) => assertLink(deps, item))
      return { items, nextCursor: null }
    }
  )

  app.post(
    '/v1/organizations/:organizationId/meetings/:meetingId/calendar-exports',
    async (request, reply) => {
      const auth = await guard(app, deps, request, reply, 'meeting.manage')
      if (!auth) return reply
      const validate = deps.registry.ajv.getSchema(EXPORT_SCHEMA)
      if (validate && validate(request.body) !== true)
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid calendar export')
      const { provider } = request.body as { provider: MeetingCalendarProvider }
      if (!PROVIDERS.includes(provider))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid calendar provider')
      const calendarId = deps.calendar?.calendarId(provider)
      if (!deps.calendar || !calendarId)
        return problem(reply, request, 503, 'CALENDAR_NOT_CONFIGURED', 'calendar is not configured')
      const meeting = await getMeeting(deps.db, auth.organizationId, auth.meetingId)
      if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      if (!meeting.scheduledStart || !meeting.scheduledEnd)
        return problem(reply, request, 409, 'MEETING_NOT_SCHEDULED', 'meeting is not scheduled')
      const link = await beginMeetingCalendarSync(deps.db, {
        organizationId: auth.organizationId,
        meetingId: auth.meetingId,
        provider,
        calendarId,
        actorUserId: auth.userId
      })
      try {
        const attendeeEmails = await listMeetingAttendeeEmails(
          deps.db,
          auth.organizationId,
          auth.meetingId
        )
        const event = await deps.calendar.upsertEvent(provider, {
          meeting,
          attendeeEmails,
          existingEventId: link.eventId
        })
        const synced = await finishMeetingCalendarSync(deps.db, {
          organizationId: auth.organizationId,
          linkId: link.id,
          eventId: event.eventId,
          webUrl: event.webUrl
        })
        assertLink(deps, synced)
        return reply.code(201).send(synced)
      } catch (error) {
        await finishMeetingCalendarSync(deps.db, {
          organizationId: auth.organizationId,
          linkId: link.id,
          error: error instanceof Error ? error.message : String(error)
        })
        return problem(reply, request, 502, 'CALENDAR_SYNC_FAILED', 'calendar export failed')
      }
    }
  )
}
