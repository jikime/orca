import {
  getMeeting,
  getMeetingGovernance,
  getMeetingParticipantForUser,
  meetingParticipantCaptureConsentReady,
  requestMeetingParticipantAdmission,
  resolveMeetingGuestSession,
  setMeetingParticipantConsent,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { stopActiveMeetingCapture } from './meeting-capture-control-routes'
import { meetingMediaRoomName, type MeetingMediaService } from './meeting-media-service'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'

const TOKEN_SCHEMA = 'https://schemas.pielab.ai/resources/meeting-media-token.v1.schema.json'
const PARTICIPANT_SCHEMA = 'https://schemas.pielab.ai/resources/meeting-participant.v1.schema.json'

type Deps = { db: PieDatabase; registry: ContractSchemaRegistry; media: MeetingMediaService }

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

async function sessionFromBody(deps: Deps, request: FastifyRequest, reply: FastifyReply) {
  const accessToken = (request.body as { accessToken?: unknown } | null)?.accessToken
  if (typeof accessToken !== 'string') {
    problem(reply, request, 400, 'VALIDATION_FAILED', 'guest access token required')
    return null
  }
  const session = await resolveMeetingGuestSession(deps.db, accessToken)
  if (!session) {
    problem(reply, request, 401, 'GUEST_SESSION_INVALID', 'guest session is invalid or expired')
    return null
  }
  return session
}

export function registerMeetingGuestMediaRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/public/meeting-guests/media-diagnostics', async (request, reply) => {
    const session = await sessionFromBody(deps, request, reply)
    if (!session) return reply
    try {
      const diagnostic = await deps.media.diagnoseConnectivity()
      const degraded = diagnostic.reachable && diagnostic.latencyMs >= 1_200
      return {
        status: diagnostic.reachable ? (degraded ? 'degraded' : 'ready') : 'unavailable',
        controlPlane: 'ready',
        media: diagnostic.reachable ? (degraded ? 'degraded' : 'ready') : 'unavailable',
        latencyMs: diagnostic.reachable ? diagnostic.latencyMs : null,
        checkedAt: new Date().toISOString()
      }
    } catch {
      return {
        status: 'unavailable',
        controlPlane: 'ready',
        media: 'unavailable',
        latencyMs: null,
        checkedAt: new Date().toISOString()
      }
    }
  })

  app.post('/v1/public/meeting-guests/waiting-room', async (request, reply) => {
    const session = await sessionFromBody(deps, request, reply)
    if (!session) return reply
    const meeting = await getMeeting(deps.db, session.organizationId, session.meetingId)
    if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
    if (meeting.status !== 'live')
      return problem(reply, request, 409, 'MEETING_NOT_LIVE', 'meeting is not live')
    const participant = await getMeetingParticipantForUser(
      deps.db,
      session.organizationId,
      session.meetingId,
      session.userId
    )
    if (!participant)
      return problem(reply, request, 403, 'MEETING_INVITATION_REQUIRED', 'meeting invite required')
    const result = await requestMeetingParticipantAdmission(deps.db, {
      organizationId: session.organizationId,
      participantId: participant.id,
      actorUserId: session.userId
    })
    if (!result.ok) return problem(reply, request, 403, 'FORBIDDEN', result.reason)
    return result.participant
  })

  app.post('/v1/public/meeting-guests/consent', async (request, reply) => {
    const session = await sessionFromBody(deps, request, reply)
    if (!session) return reply
    const body = request.body as {
      accessToken: string
      consent?: unknown
      expectedVersion?: unknown
    }
    if (typeof body.consent !== 'boolean' || !Number.isInteger(body.expectedVersion))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'consent and version required')
    const participant = await getMeetingParticipantForUser(
      deps.db,
      session.organizationId,
      session.meetingId,
      session.userId
    )
    if (!participant)
      return problem(reply, request, 404, 'NOT_FOUND', 'meeting participant not found')
    const result = await setMeetingParticipantConsent(deps.db, {
      organizationId: session.organizationId,
      participantId: participant.id,
      actorUserId: session.userId,
      expectedVersion: body.expectedVersion as number,
      consent: body.consent
    })
    if (!result.ok) return problem(reply, request, 409, 'CONSENT_UPDATE_FAILED', result.reason)
    const validate = deps.registry.ajv.getSchema(PARTICIPANT_SCHEMA)
    if (validate && validate(result.participant) !== true)
      throw new Error('guest participant violates contract')
    return result.participant
  })

  app.post('/v1/public/meeting-guests/media-token', async (request, reply) => {
    const session = await sessionFromBody(deps, request, reply)
    if (!session) return reply
    const meeting = await getMeeting(deps.db, session.organizationId, session.meetingId)
    if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
    if (meeting.status !== 'live')
      return problem(reply, request, 409, 'MEETING_NOT_LIVE', 'meeting is not live')
    const participant = await getMeetingParticipantForUser(
      deps.db,
      session.organizationId,
      session.meetingId,
      session.userId
    )
    if (!participant || participant.accessStatus !== 'admitted') {
      return problem(reply, request, 425, 'MEETING_ADMISSION_REQUIRED', 'waiting for host approval')
    }
    try {
      const governance = await getMeetingGovernance(
        deps.db,
        session.organizationId,
        session.meetingId
      )
      if (
        governance?.captureStatus === 'active' &&
        !(await meetingParticipantCaptureConsentReady(deps.db, {
          organizationId: session.organizationId,
          meetingId: session.meetingId,
          participantId: participant.id,
          captureTypes: governance.activeCaptureTypes
        }))
      ) {
        await stopActiveMeetingCapture(deps, {
          organizationId: session.organizationId,
          meetingId: session.meetingId,
          actorUserId: session.userId,
          status: 'paused'
        })
      }
      const roomName = meetingMediaRoomName(session.organizationId, session.meetingId)
      await deps.media.ensureRoom({
        roomName,
        organizationId: session.organizationId,
        meetingId: session.meetingId,
        title: meeting.title
      })
      const issued = await deps.media.issueParticipantToken({
        roomName,
        userId: session.userId,
        role: participant.role
      })
      const response = {
        serverUrl: deps.media.serverUrl,
        roomName,
        token: issued.token,
        expiresAt: issued.expiresAt,
        participant
      }
      const validate = deps.registry.ajv.getSchema(TOKEN_SCHEMA)
      if (validate && validate(response) !== true)
        throw new Error('guest media token violates contract')
      return response
    } catch (error) {
      request.log.error({ err: error }, 'failed to issue guest media token')
      return problem(reply, request, 503, 'MEDIA_UNAVAILABLE', 'meeting media is unavailable')
    }
  })
}
