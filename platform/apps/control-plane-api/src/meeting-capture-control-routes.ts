import {
  attachMeetingRecordingMedia,
  failMeetingRecordingStart,
  getMeetingGovernance,
  listActiveMeetingRecordingControlStates,
  markMeetingRecordingStopped,
  setMeetingCaptureStatus,
  startMeetingRecording,
  type MeetingCaptureType,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'
import { meetingMediaRoomName, type MeetingMediaService } from './meeting-media-service'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type MediaDeps = { db: PieDatabase; media: MeetingMediaService }
type Deps = MediaDeps & { registry: ContractSchemaRegistry }

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

async function authorize(
  app: FastifyInstance,
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string
): Promise<{ userId: string } | null> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return null
  const result = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    'meeting.manage'
  )
  return result ? { userId: result.userId ?? organizationId } : null
}

export async function stopActiveMeetingCapture(
  deps: MediaDeps,
  input: {
    organizationId: string
    meetingId: string
    actorUserId: string
    status: 'paused' | 'stopped'
    captureType?: MeetingCaptureType
  }
): Promise<number> {
  const recordings = await listActiveMeetingRecordingControlStates(
    deps.db,
    input.organizationId,
    input.meetingId
  )
  const affected = input.captureType
    ? recordings.filter((recording) => recording.captureTypes.includes(input.captureType!))
    : recordings
  const roomName = meetingMediaRoomName(input.organizationId, input.meetingId)
  for (const recording of affected) {
    await deps.media.stopRecording({
      roomName,
      videoEgressId: recording.videoEgressId,
      audioEgressId: recording.audioEgressId,
      transcriptionDispatchId: recording.transcriptionDispatchId
    })
    await markMeetingRecordingStopped(deps.db, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      recordingId: recording.id
    })
  }
  if (affected.length > 0) {
    await setMeetingCaptureStatus(deps.db, {
      organizationId: input.organizationId,
      meetingId: input.meetingId,
      actorUserId: input.actorUserId,
      status: input.status,
      ...(input.status === 'stopped' ? { captureTypes: [] } : {})
    })
  }
  return affected.length
}

export function registerMeetingCaptureControlRoutes(app: FastifyInstance, deps: Deps): void {
  app.post(
    '/v1/organizations/:organizationId/meetings/:meetingId/capture/:action',
    (request, reply) => {
      // One explicit action segment avoids Fastify interpreting a literal colon as a route parameter.
      const { action } = request.params as { action: string }
      if (action !== 'pause' && action !== 'resume') {
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown capture action')
      }
      return captureControlHandler(app, deps, request, reply, action)
    }
  )
}

async function captureControlHandler(
  app: FastifyInstance,
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  action: 'pause' | 'resume'
): Promise<unknown> {
  const { organizationId, meetingId } = request.params as {
    organizationId: string
    meetingId: string
  }
  if (!UUID_PATTERN.test(meetingId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
  const auth = await authorize(app, deps, request, reply, organizationId)
  if (!auth) return reply
  if (action === 'resume') {
    return resumeMeetingCapture(deps, request, reply, organizationId, meetingId, auth.userId)
  }
  try {
    const count = await stopActiveMeetingCapture(deps, {
      organizationId,
      meetingId,
      actorUserId: auth.userId,
      status: 'paused'
    })
    if (count === 0)
      return problem(reply, request, 409, 'CAPTURE_NOT_ACTIVE', 'capture is not active')
    const governance = await getMeetingGovernance(deps.db, organizationId, meetingId)
    return governance ?? problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
  } catch (error) {
    request.log.error({ err: error }, 'failed to pause meeting capture')
    return problem(reply, request, 503, 'CAPTURE_UNAVAILABLE', 'capture could not be paused')
  }
}

async function resumeMeetingCapture(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  meetingId: string,
  actorUserId: string
): Promise<unknown> {
  const governance = await getMeetingGovernance(deps.db, organizationId, meetingId)
  if (!governance) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
  if (governance.captureStatus !== 'paused')
    return problem(reply, request, 409, 'CAPTURE_NOT_PAUSED', 'capture is not paused')
  const captureTypes = governance.activeCaptureTypes.filter(
    (type): type is 'recording' | 'transcription' | 'ai_notes' =>
      type === 'recording' || type === 'transcription' || type === 'ai_notes'
  )
  const started = await startMeetingRecording(deps.db, {
    organizationId,
    actorUserId,
    meetingId,
    captureTypes
  })
  if (!started.ok) {
    if (started.reason === 'consent_required')
      return problem(reply, request, 422, 'CONSENT_REQUIRED', 'current capture consent is required')
    return problem(reply, request, 409, 'CAPTURE_RESUME_BLOCKED', started.reason)
  }
  const roomName = meetingMediaRoomName(organizationId, meetingId)
  try {
    const session = await deps.media.startRecording({
      roomName,
      organizationId,
      meetingId,
      recordingId: started.recording.id,
      captureTypes
    })
    const attached = await attachMeetingRecordingMedia(deps.db, {
      organizationId,
      actorUserId,
      recordingId: started.recording.id,
      expectedVersion: started.recording.version,
      ...session
    })
    if (!attached) throw new Error('recording changed before media attachment')
    await setMeetingCaptureStatus(deps.db, {
      organizationId,
      meetingId,
      actorUserId,
      status: 'active',
      captureTypes
    })
    void reply.header('etag', `"meeting-recording-${attached.version}"`)
    return attached
  } catch (error) {
    await failMeetingRecordingStart(deps.db, {
      organizationId,
      actorUserId,
      recordingId: started.recording.id,
      errorCode: 'MEDIA_EGRESS_RESUME_FAILED'
    })
    request.log.error({ err: error }, 'failed to resume meeting capture')
    return problem(reply, request, 503, 'CAPTURE_UNAVAILABLE', 'capture could not be resumed')
  }
}
