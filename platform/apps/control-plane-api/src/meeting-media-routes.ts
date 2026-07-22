import {
  applyMeetingEgressEnded,
  applyMeetingMediaPresenceEvent,
  ensureMeetingHostParticipant,
  getMeeting,
  getMeetingGovernance,
  getMeetingParticipantForUser,
  meetingCaptureConsentReady,
  meetingParticipantCaptureConsentReady,
  requestMeetingParticipantAdmission,
  type MeetingParticipantResource,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import {
  meetingMediaRoomName,
  parseMeetingMediaRoomName,
  type MeetingMediaService,
  type MeetingMediaWebhookEvent
} from './meeting-media-service'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'
import { stopActiveMeetingCapture } from './meeting-capture-control-routes'

const MEDIA_TOKEN_SCHEMA = 'https://schemas.pielab.ai/resources/meeting-media-token.v1.schema.json'
const MEDIA_DIAGNOSTICS_SCHEMA =
  'https://schemas.pielab.ai/resources/meeting-media-diagnostics.v1.schema.json'
const PARTICIPANT_SCHEMA = 'https://schemas.pielab.ai/resources/meeting-participant.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type MeetingMediaRoutesDeps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  media: MeetingMediaService
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

async function guard(
  app: FastifyInstance,
  deps: MeetingMediaRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string
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
    'meeting.read'
  )
  return authz ? { userId: authz.userId ?? organizationId } : null
}

export function registerMeetingMediaWebhookRoute(
  app: FastifyInstance,
  deps: Pick<MeetingMediaRoutesDeps, 'db' | 'media'>
): void {
  app.post('/v1/media/livekit/webhook', async (request, reply) => {
    let event: MeetingMediaWebhookEvent | null
    try {
      // LiveKit signs the exact raw body, so parsing it as JSON first would invalidate verification.
      event = await deps.media.receiveWebhook(request.body as string, request.headers.authorization)
    } catch (error) {
      request.log.warn({ err: error }, 'rejected LiveKit webhook')
      return problem(reply, request, 401, 'INVALID_WEBHOOK_SIGNATURE', 'invalid media webhook')
    }
    if (!event) return reply.code(204).send()
    const room = parseMeetingMediaRoomName(event.roomName)
    if (!room) return reply.code(204).send()
    if (event.eventType === 'egress_ended') {
      await applyMeetingEgressEnded(deps.db, {
        organizationId: room.organizationId,
        meetingId: room.meetingId,
        eventId: event.eventId,
        egressId: event.egressId,
        succeeded: event.succeeded,
        durationSeconds: event.durationSeconds,
        errorCode: event.errorCode,
        occurredAt: event.occurredAt
      })
      return reply.code(204).send()
    }
    // Recorder and agent identities are LiveKit internals, not Pie user UUIDs.
    if (!UUID_PATTERN.test(event.participantIdentity)) return reply.code(204).send()
    await applyMeetingMediaPresenceEvent(deps.db, {
      organizationId: room.organizationId,
      meetingId: room.meetingId,
      eventId: event.eventId,
      eventType: event.eventType,
      participantUserId: event.participantIdentity,
      occurredAt: event.occurredAt
    })
    if (event.eventType === 'participant_joined') {
      try {
        const governance = await getMeetingGovernance(deps.db, room.organizationId, room.meetingId)
        const ready = governance
          ? await meetingCaptureConsentReady(
              deps.db,
              room.organizationId,
              room.meetingId,
              governance.activeCaptureTypes
            )
          : false
        if (governance?.captureStatus === 'active' && !ready) {
          // A newly joined participant cannot be captured before accepting the current policy.
          await stopActiveMeetingCapture(deps, {
            organizationId: room.organizationId,
            meetingId: room.meetingId,
            actorUserId: event.participantIdentity,
            status: 'paused'
          })
        }
      } catch (error) {
        request.log.error({ err: error }, 'failed to pause capture for a newly joined participant')
      }
    }
    return reply.code(204).send()
  })
}

export function registerMeetingMediaTokenRoute(
  app: FastifyInstance,
  deps: MeetingMediaRoutesDeps
): void {
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/media-diagnostics',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      const auth = await guard(app, deps, request, reply, organizationId)
      if (!auth) return reply
      if (!UUID_PATTERN.test(meetingId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      }
      const meeting = await getMeeting(deps.db, organizationId, meetingId)
      if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      const participant = await getMeetingParticipantForUser(
        deps.db,
        organizationId,
        meetingId,
        auth.userId
      )
      if (!participant && meeting.hostUserId !== auth.userId) {
        return problem(
          reply,
          request,
          403,
          'MEETING_INVITATION_REQUIRED',
          'meeting invite required'
        )
      }
      if (participant?.accessStatus === 'blocked' || participant?.accessStatus === 'denied') {
        return problem(reply, request, 403, 'MEETING_ACCESS_BLOCKED', 'meeting access was revoked')
      }
      let response: {
        status: 'ready' | 'degraded' | 'unavailable'
        controlPlane: 'ready'
        media: 'ready' | 'degraded' | 'unavailable'
        latencyMs: number | null
        checkedAt: string
      }
      try {
        const diagnostic = await deps.media.diagnoseConnectivity()
        if (!diagnostic.reachable) throw new Error('LiveKit endpoint is unreachable')
        const degraded = diagnostic.latencyMs >= 1_200
        response = {
          status: degraded ? 'degraded' : 'ready',
          controlPlane: 'ready',
          media: degraded ? 'degraded' : 'ready',
          latencyMs: diagnostic.latencyMs,
          checkedAt: new Date().toISOString()
        }
      } catch (error) {
        request.log.warn({ err: error }, 'meeting media diagnostic failed')
        response = {
          status: 'unavailable',
          controlPlane: 'ready',
          media: 'unavailable',
          latencyMs: null,
          checkedAt: new Date().toISOString()
        }
      }
      const validate = deps.registry.ajv.getSchema(MEDIA_DIAGNOSTICS_SCHEMA)
      if (validate && validate(response) !== true) {
        throw new Error('meeting media diagnostic response violates its contract')
      }
      return response
    }
  )

  app.post(
    '/v1/organizations/:organizationId/meetings/:meetingId/waiting-room',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      const auth = await guard(app, deps, request, reply, organizationId)
      if (!auth) return reply
      if (!UUID_PATTERN.test(meetingId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      }
      const meeting = await getMeeting(deps.db, organizationId, meetingId)
      if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      if (meeting.status !== 'live') {
        return problem(reply, request, 409, 'MEETING_NOT_LIVE', 'meeting is not live')
      }
      let participant = await getMeetingParticipantForUser(
        deps.db,
        organizationId,
        meetingId,
        auth.userId
      )
      if (!participant && meeting.hostUserId === auth.userId) {
        participant = await ensureMeetingHostParticipant(deps.db, {
          organizationId,
          meetingId,
          hostUserId: auth.userId
        })
      }
      if (!participant) {
        return problem(
          reply,
          request,
          403,
          'MEETING_INVITATION_REQUIRED',
          'meeting invite required'
        )
      }
      const requested = await requestMeetingParticipantAdmission(deps.db, {
        organizationId,
        participantId: participant.id,
        actorUserId: auth.userId
      })
      if (!requested.ok) {
        return problem(reply, request, 403, 'FORBIDDEN', requested.reason)
      }
      const validate = deps.registry.ajv.getSchema(PARTICIPANT_SCHEMA)
      if (validate && validate(requested.participant) !== true) {
        throw new Error('meeting waiting-room response violates its contract')
      }
      return requested.participant
    }
  )

  app.post(
    '/v1/organizations/:organizationId/meetings/:meetingId/media-token',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      const auth = await guard(app, deps, request, reply, organizationId)
      if (!auth) return reply
      if (!UUID_PATTERN.test(meetingId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      }
      const meeting = await getMeeting(deps.db, organizationId, meetingId)
      if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      if (meeting.status !== 'live') {
        return problem(reply, request, 409, 'MEETING_NOT_LIVE', 'meeting is not live')
      }

      let participant = await getMeetingParticipantForUser(
        deps.db,
        organizationId,
        meetingId,
        auth.userId
      )
      if (!participant && meeting.hostUserId === auth.userId) {
        participant = await ensureMeetingHostParticipant(deps.db, {
          organizationId,
          meetingId,
          hostUserId: auth.userId
        })
      }
      if (!participant) {
        return problem(
          reply,
          request,
          403,
          'MEETING_INVITATION_REQUIRED',
          'meeting invite required'
        )
      }
      if (participant.accessStatus === 'blocked' || participant.accessStatus === 'denied') {
        return problem(reply, request, 403, 'MEETING_ACCESS_BLOCKED', 'meeting access was revoked')
      }
      if (participant.accessStatus !== 'admitted') {
        const requested = await requestMeetingParticipantAdmission(deps.db, {
          organizationId,
          participantId: participant.id,
          actorUserId: auth.userId
        })
        if (!requested.ok) {
          return problem(reply, request, 403, 'FORBIDDEN', requested.reason)
        }
        return problem(
          reply,
          request,
          425,
          'MEETING_ADMISSION_REQUIRED',
          'waiting for host approval'
        )
      }

      const roomName = meetingMediaRoomName(organizationId, meetingId)
      try {
        const governance = await getMeetingGovernance(deps.db, organizationId, meetingId)
        if (
          governance?.captureStatus === 'active' &&
          !(await meetingParticipantCaptureConsentReady(deps.db, {
            organizationId,
            meetingId,
            participantId: participant.id,
            captureTypes: governance.activeCaptureTypes
          }))
        ) {
          // Pause before issuing a token so an unconsented participant is never briefly captured.
          await stopActiveMeetingCapture(deps, {
            organizationId,
            meetingId,
            actorUserId: auth.userId,
            status: 'paused'
          })
        }
        await deps.media.ensureRoom({
          roomName,
          organizationId,
          meetingId,
          title: meeting.title
        })
        const issued = await deps.media.issueParticipantToken({
          roomName,
          userId: auth.userId,
          role: participant.role
        })
        return sendTokenResponse(deps, reply, {
          serverUrl: deps.media.serverUrl,
          roomName,
          token: issued.token,
          expiresAt: issued.expiresAt,
          participant
        })
      } catch (error) {
        request.log.error({ err: error }, 'failed to issue meeting media token')
        return problem(reply, request, 503, 'MEDIA_UNAVAILABLE', 'meeting media is unavailable')
      }
    }
  )
}

function sendTokenResponse(
  deps: MeetingMediaRoutesDeps,
  reply: FastifyReply,
  response: {
    serverUrl: string
    roomName: string
    token: string
    expiresAt: string
    participant: MeetingParticipantResource
  }
): unknown {
  const validate = deps.registry.ajv.getSchema(MEDIA_TOKEN_SCHEMA)
  if (validate && validate(response) !== true) {
    throw new Error('meeting media token response violates its contract')
  }
  return reply.send(response)
}
