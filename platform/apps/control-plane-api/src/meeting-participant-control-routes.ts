import {
  auditMeetingParticipantMuted,
  blockMeetingParticipant,
  getMeeting,
  getMeetingParticipant,
  getMeetingParticipantForUser,
  setMeetingParticipantAccess,
  setMeetingParticipantRole,
  type MeetingParticipantResource,
  type MeetingParticipantRole,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { meetingMediaRoomName, type MeetingMediaService } from './meeting-media-service'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PARTICIPANT_SCHEMA = 'https://schemas.pielab.ai/resources/meeting-participant.v1.schema.json'
const ROLE_UPDATE_SCHEMA =
  'https://schemas.pielab.ai/resources/meeting-participant-role-update.v1.schema.json'
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

function assertParticipant(
  registry: ContractSchemaRegistry,
  participant: MeetingParticipantResource
): void {
  const validate = registry.ajv.getSchema(PARTICIPANT_SCHEMA)
  if (validate && validate(participant) !== true) {
    throw new Error('meeting participant response violates its contract')
  }
}

async function authorize(
  app: FastifyInstance,
  deps: Deps,
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
  const result = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    'meeting.read'
  )
  return result ? { userId: result.userId ?? organizationId } : null
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"meeting-participant-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

async function canManageParticipant(
  deps: Deps,
  organizationId: string,
  meeting: { id: string; hostUserId: string },
  actorUserId: string
): Promise<boolean> {
  if (meeting.hostUserId === actorUserId) return true
  const actor = await getMeetingParticipantForUser(deps.db, organizationId, meeting.id, actorUserId)
  return actor?.role === 'co_host' && actor.accessStatus === 'admitted'
}

function parseTarget(target: string): { id: string; action: string } {
  const colon = target.lastIndexOf(':')
  return {
    id: colon < 0 ? target : target.slice(0, colon),
    action: colon < 0 ? '' : target.slice(colon + 1)
  }
}

export function registerMeetingParticipantControlRoutes(app: FastifyInstance, deps: Deps): void {
  app.post(
    '/v1/organizations/:organizationId/meeting-participant-controls/:participantTarget',
    async (request, reply) => {
      const { organizationId, participantTarget } = request.params as {
        organizationId: string
        participantTarget: string
      }
      const auth = await authorize(app, deps, request, reply, organizationId)
      if (!auth) return reply
      const { id: participantId, action } = parseTarget(participantTarget)
      if (
        !UUID_PATTERN.test(participantId) ||
        !['mute', 'remove', 'admit', 'deny'].includes(action)
      ) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid participant control')
      }
      const participant = await getMeetingParticipant(deps.db, organizationId, participantId)
      if (!participant) return problem(reply, request, 404, 'NOT_FOUND', 'participant not found')
      if (participant.role === 'host') {
        return problem(
          reply,
          request,
          422,
          'HOST_PROTECTED',
          'the meeting host cannot be controlled'
        )
      }
      const meeting = await getMeeting(deps.db, organizationId, participant.meetingId)
      if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      if (!(await canManageParticipant(deps, organizationId, meeting, auth.userId))) {
        return problem(reply, request, 403, 'HOST_PERMISSION_REQUIRED', 'host permission required')
      }
      if (meeting.status !== 'live') {
        return problem(reply, request, 409, 'MEETING_NOT_LIVE', 'meeting is not live')
      }
      if (action === 'admit' || action === 'deny') {
        const expectedVersion = ifMatchVersion(request)
        if (expectedVersion === null) {
          return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
        }
        if (action === 'deny' && participant.joinedAt && !participant.leftAt) {
          await deps.media.removeParticipant({
            roomName: meetingMediaRoomName(organizationId, meeting.id),
            userId: participant.userId
          })
        }
        const changed = await setMeetingParticipantAccess(deps.db, {
          organizationId,
          participantId,
          actorUserId: auth.userId,
          expectedVersion,
          accessStatus: action === 'admit' ? 'admitted' : 'denied'
        })
        if (!changed.ok) {
          const status =
            changed.reason === 'not_found' ? 404 : changed.reason === 'version_conflict' ? 409 : 422
          return problem(reply, request, status, changed.reason.toUpperCase(), changed.reason)
        }
        assertParticipant(deps.registry, changed.participant)
        void reply.header('etag', `"meeting-participant-${changed.participant.version}"`)
        return changed.participant
      }
      if (action === 'remove' && participant.accessStatus === 'blocked') return participant
      const roomName = meetingMediaRoomName(organizationId, participant.meetingId)
      try {
        if (action === 'mute') {
          const muted = await deps.media.muteParticipantMicrophone({
            roomName,
            userId: participant.userId
          })
          if (!muted) {
            return problem(
              reply,
              request,
              409,
              'MICROPHONE_NOT_ACTIVE',
              'participant has no active microphone'
            )
          }
          await auditMeetingParticipantMuted(deps.db, {
            organizationId,
            participantId,
            actorUserId: auth.userId
          })
          return reply.code(204).send()
        }
        await deps.media.removeParticipant({ roomName, userId: participant.userId })
        const blocked = await blockMeetingParticipant(deps.db, {
          organizationId,
          participantId,
          actorUserId: auth.userId
        })
        if (!blocked.ok) {
          return problem(reply, request, 409, 'PARTICIPANT_CONTROL_FAILED', blocked.reason)
        }
        assertParticipant(deps.registry, blocked.participant)
        return blocked.participant
      } catch (error) {
        request.log.error({ err: error }, 'meeting participant media control failed')
        return problem(reply, request, 503, 'MEDIA_UNAVAILABLE', 'meeting media is unavailable')
      }
    }
  )

  app.patch(
    '/v1/organizations/:organizationId/meeting-participants/:participantId',
    async (request, reply) => {
      const { organizationId, participantId } = request.params as {
        organizationId: string
        participantId: string
      }
      const auth = await authorize(app, deps, request, reply, organizationId)
      if (!auth) return reply
      if (!UUID_PATTERN.test(participantId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid participant id')
      }
      const validate = deps.registry.ajv.getSchema(ROLE_UPDATE_SCHEMA)
      if (validate && validate(request.body) !== true) {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid participant role')
      }
      const participant = await getMeetingParticipant(deps.db, organizationId, participantId)
      if (!participant) return problem(reply, request, 404, 'NOT_FOUND', 'participant not found')
      const meeting = await getMeeting(deps.db, organizationId, participant.meetingId)
      if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      if (!(await canManageParticipant(deps, organizationId, meeting, auth.userId))) {
        return problem(reply, request, 403, 'HOST_PERMISSION_REQUIRED', 'host permission required')
      }
      if (meeting.status === 'ended' || meeting.status === 'cancelled') {
        return problem(reply, request, 409, 'MEETING_CLOSED', 'meeting is closed')
      }
      const expectedVersion = ifMatchVersion(request)
      if (expectedVersion === null) {
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      }
      const { role } = request.body as {
        role: Exclude<MeetingParticipantRole, 'host'>
      }
      if (participant.joinedAt && !participant.leftAt) {
        try {
          // Revoke before changing role so a downgrade cannot retain an older publish capability.
          await deps.media.removeParticipant({
            roomName: meetingMediaRoomName(organizationId, meeting.id),
            userId: participant.userId
          })
        } catch (error) {
          request.log.error({ err: error }, 'failed to revoke participant token before role change')
          return problem(reply, request, 503, 'MEDIA_UNAVAILABLE', 'meeting media is unavailable')
        }
      }
      const changed = await setMeetingParticipantRole(deps.db, {
        organizationId,
        participantId,
        actorUserId: auth.userId,
        expectedVersion,
        role
      })
      if (!changed.ok) {
        const status =
          changed.reason === 'not_found' ? 404 : changed.reason === 'version_conflict' ? 409 : 422
        return problem(reply, request, status, changed.reason.toUpperCase(), changed.reason)
      }
      assertParticipant(deps.registry, changed.participant)
      void reply.header('etag', `"meeting-participant-${changed.participant.version}"`)
      return changed.participant
    }
  )
}
