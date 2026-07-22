import {
  addMeetingParticipant,
  attachMeetingRecordingMedia,
  createMeeting,
  createMeetingMinutes,
  createMeetingTranscript,
  finalizeMeetingMinutes,
  finalizeMeetingRecording,
  failMeetingRecordingStart,
  getMeetingRecording,
  getMeetingRecordingControlState,
  getMeeting,
  getMeetingMinutes,
  listMeetingMinutes,
  listMeetingParticipants,
  listMeetingProcessingJobs,
  listMeetingRecordings,
  listActiveMeetingRecordingControlStates,
  listMeetingTranscripts,
  listMeetings,
  markMeetingRecordingStopped,
  reviewMeetingMinutes,
  setMeetingCaptureStatus,
  setMeetingParticipantConsent,
  startMeetingRecording,
  transitionMeeting,
  type MeetingResource,
  type MeetingCaptureType,
  type MeetingRecurrence,
  type MeetingScopeKind,
  type MeetingStatus,
  type MinutesReviewDecision,
  type PieDatabase,
  type TranscriptSource
} from '@pie/persistence'
import { createTenantObjectKeyBuilder, type ObjectStorage } from '@pie/object-storage-adapter'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'
import { meetingMediaRoomName, type MeetingMediaService } from './meeting-media-service'
import { registerMeetingAgendaRoutes } from './meeting-agenda-routes'
import { registerMeetingTranscriptSegmentRoutes } from './meeting-transcript-segment-routes'
import { registerMeetingDecisionRoutes } from './meeting-decision-routes'
import { registerMeetingActionItemRoutes } from './meeting-action-item-routes'
import { registerMeetingParticipantControlRoutes } from './meeting-participant-control-routes'
import { registerMeetingGovernanceRoutes } from './meeting-governance-routes'
import {
  registerMeetingCaptureControlRoutes,
  stopActiveMeetingCapture
} from './meeting-capture-control-routes'
import { registerMeetingCalendarRoutes } from './meeting-calendar-routes'
import type { MeetingCalendarService } from './meeting-calendar-service'
import { registerMeetingGuestLinkRoutes } from './meeting-guest-link-routes'

const SCHEMA = {
  meeting: 'https://schemas.pielab.ai/resources/meeting.v1.schema.json',
  meetingCreate: 'https://schemas.pielab.ai/resources/meeting-create.v1.schema.json',
  meetingTransition: 'https://schemas.pielab.ai/resources/meeting-transition.v1.schema.json',
  participant: 'https://schemas.pielab.ai/resources/meeting-participant.v1.schema.json',
  participantAdd: 'https://schemas.pielab.ai/resources/meeting-participant-add.v1.schema.json',
  participantConsent:
    'https://schemas.pielab.ai/resources/meeting-participant-consent.v1.schema.json',
  recording: 'https://schemas.pielab.ai/resources/meeting-recording.v1.schema.json',
  recordingStart: 'https://schemas.pielab.ai/resources/meeting-recording-start.v1.schema.json',
  recordingPlayback:
    'https://schemas.pielab.ai/resources/meeting-recording-playback.v1.schema.json',
  recordingFinalize:
    'https://schemas.pielab.ai/resources/meeting-recording-finalize.v1.schema.json',
  transcript: 'https://schemas.pielab.ai/resources/meeting-transcript.v1.schema.json',
  transcriptCreate: 'https://schemas.pielab.ai/resources/meeting-transcript-create.v1.schema.json',
  processingJob: 'https://schemas.pielab.ai/resources/meeting-processing-job.v1.schema.json',
  minutes: 'https://schemas.pielab.ai/resources/meeting-minutes.v1.schema.json',
  minutesCreate: 'https://schemas.pielab.ai/resources/meeting-minutes-create.v1.schema.json',
  minutesReview: 'https://schemas.pielab.ai/resources/meeting-minutes-review.v1.schema.json'
} as const

// meeting.read gates reading/listing; meeting.manage gates create/transition/participant/recording/
// transcript/minutes authoring; meeting.minutes.review gates the AI-minutes reviewer verdict.
const PERM_READ = 'meeting.read'
const PERM_MANAGE = 'meeting.manage'
const PERM_MINUTES_REVIEW = 'meeting.minutes.review'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type MeetingRoutesDeps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  media?: MeetingMediaService
  objectStorage?: ObjectStorage
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

function validates(registry: ContractSchemaRegistry, schemaId: string, body: unknown): boolean {
  const validate = registry.ajv.getSchema(schemaId)
  return !validate || validate(body) === true
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
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

// Splits `<id>:<action>` (custom method), mirroring the automation / qa action routes.
function parseTarget(target: string): { id: string; action: string } {
  const colon = target.lastIndexOf(':')
  return {
    id: colon === -1 ? target : target.slice(0, colon),
    action: colon === -1 ? '' : target.slice(colon + 1)
  }
}

async function guard(
  deps: MeetingRoutesDeps,
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

export function registerMeetingRoutes(app: FastifyInstance, deps: MeetingRoutesDeps): void {
  registerMeetingCollection(app, deps)
  registerParticipantRoutes(app, deps)
  registerRecordingRoutes(app, deps)
  registerProcessingJobRoutes(app, deps)
  registerTranscriptRoutes(app, deps)
  registerMinutesRoutes(app, deps)
  registerMeetingAgendaRoutes(app, deps)
  registerMeetingTranscriptSegmentRoutes(app, deps)
  registerMeetingDecisionRoutes(app, deps)
  registerMeetingActionItemRoutes(app, deps)
  registerMeetingGovernanceRoutes(app, deps)
  registerMeetingCalendarRoutes(app, deps)
  registerMeetingGuestLinkRoutes(app, deps)
  if (deps.media) registerMeetingCaptureControlRoutes(app, { ...deps, media: deps.media })
  if (deps.media) registerMeetingParticipantControlRoutes(app, { ...deps, media: deps.media })
}

// === meetings ===
function registerMeetingCollection(app: FastifyInstance, deps: MeetingRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/meetings', (request, reply) =>
    createMeetingHandler(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/meetings', async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }
    const auth = await guard(deps, app, request, reply, organizationId, PERM_READ)
    if (!auth) return reply
    const { cursor, scopeKind, scopeId } = request.query as {
      cursor?: string
      scopeKind?: MeetingScopeKind
      scopeId?: string
    }
    const page = await listMeetings(deps.db, organizationId, {
      cursor: cursor ?? null,
      ...(scopeKind ? { scopeKind } : {}),
      scopeId: scopeId ?? null
    })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.meeting, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
  app.get('/v1/organizations/:organizationId/meetings/:meetingId', async (request, reply) => {
    const { organizationId, meetingId } = request.params as {
      organizationId: string
      meetingId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, PERM_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(meetingId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const meeting = await getMeeting(deps.db, organizationId, meetingId)
    if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
    assertResponse(deps.registry, SCHEMA.meeting, meeting)
    void reply.header('etag', etag('meeting', meeting.version))
    return meeting
  })
  app.post('/v1/organizations/:organizationId/meetings/:meetingTarget', (request, reply) =>
    transitionMeetingHandler(app, deps, request, reply)
  )
}

async function createMeetingHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId } = request.params as { organizationId: string }
  const auth = await guard(deps, app, request, reply, organizationId, PERM_MANAGE)
  if (!auth) return reply
  if (!validates(deps.registry, SCHEMA.meetingCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid meeting create')
  const body = request.body as {
    title: string
    scopeKind?: MeetingScopeKind
    scopeId?: string
    hostUserId?: string
    scheduledStart?: string
    scheduledEnd?: string
    timeZone?: string
    recurrence?: MeetingRecurrence
  }
  // A scoped meeting must name its scope id (mirrors the migration CHECK) — a 400, not a DB error.
  if (body.scopeKind && body.scopeKind !== 'none' && !body.scopeId)
    return problem(
      reply,
      request,
      400,
      'VALIDATION_FAILED',
      'scopeId is required for a scoped meeting'
    )
  if (Boolean(body.scheduledStart) !== Boolean(body.scheduledEnd)) {
    return problem(
      reply,
      request,
      400,
      'VALIDATION_FAILED',
      'scheduledStart and scheduledEnd must be provided together'
    )
  }
  if (
    body.scheduledStart &&
    body.scheduledEnd &&
    new Date(body.scheduledEnd).getTime() <= new Date(body.scheduledStart).getTime()
  ) {
    return problem(
      reply,
      request,
      400,
      'VALIDATION_FAILED',
      'scheduledEnd must be after scheduledStart'
    )
  }
  if (body.timeZone && !isTimeZone(body.timeZone)) {
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'timeZone must be an IANA time zone')
  }
  if (body.recurrence && body.recurrence !== 'none' && !body.scheduledStart) {
    return problem(
      reply,
      request,
      400,
      'VALIDATION_FAILED',
      'a recurring meeting requires a schedule'
    )
  }
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/meetings'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (meeting: MeetingResource): MeetingResource => {
    assertResponse(deps.registry, SCHEMA.meeting, meeting)
    void reply
      .code(201)
      .header('etag', etag('meeting', meeting.version))
      .header('location', `/v1/organizations/${organizationId}/meetings/${meeting.id}`)
    return meeting
  }
  if (gate.priorResourceId) {
    const existing = await getMeeting(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const created = await createMeeting(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    title: body.title,
    hostUserId: body.hostUserId ?? auth.userId,
    ...(body.scopeKind ? { scopeKind: body.scopeKind } : {}),
    scopeId: body.scopeId ?? null,
    scheduledStart: body.scheduledStart ?? null,
    scheduledEnd: body.scheduledEnd ?? null,
    timeZone: body.timeZone ?? 'UTC',
    recurrence: body.recurrence ?? 'none'
  })
  await gate.complete(created.id)
  return respond(created)
}

async function transitionMeetingHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, meetingTarget } = request.params as {
    organizationId: string
    meetingTarget: string
  }
  const { id: meetingId, action } = parseTarget(meetingTarget)
  if (action !== 'transition')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown meeting action')
  const auth = await guard(deps, app, request, reply, organizationId, PERM_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(meetingId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.meetingTransition, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid meeting transition')
  const expectedVersion = ifMatchVersion(request, 'meeting')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const { toStatus } = request.body as { toStatus: MeetingStatus }
  const result = await transitionMeeting(deps.db, {
    organizationId,
    meetingId,
    actorUserId: auth.userId,
    expectedVersion,
    toStatus
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'meeting modified concurrently')
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot move a meeting from ${result.from} to ${toStatus}`
    )
  }
  if (deps.media && (toStatus === 'ended' || toStatus === 'cancelled')) {
    try {
      const roomName = meetingMediaRoomName(organizationId, meetingId)
      const recordings = await listActiveMeetingRecordingControlStates(
        deps.db,
        organizationId,
        meetingId
      )
      await Promise.allSettled(
        recordings.map(async (recording) => {
          await deps.media!.stopRecording({
            roomName,
            videoEgressId: recording.videoEgressId,
            audioEgressId: recording.audioEgressId,
            transcriptionDispatchId: recording.transcriptionDispatchId
          })
          await markMeetingRecordingStopped(deps.db, {
            organizationId,
            actorUserId: auth.userId,
            recordingId: recording.id
          })
        })
      )
      // Closing happens after stop requests so Egress can flush valid file trailers before ejection.
      await deps.media.closeRoom(meetingMediaRoomName(organizationId, meetingId))
    } catch (error) {
      request.log.error({ err: error }, 'failed to close ended meeting media room')
    }
  }
  assertResponse(deps.registry, SCHEMA.meeting, result.meeting)
  void reply.header('etag', etag('meeting', result.meeting.version))
  return result.meeting
}

// === participants ===
function registerParticipantRoutes(app: FastifyInstance, deps: MeetingRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/meetings/:meetingId/participants', (request, reply) =>
    addParticipantHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/participants',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, PERM_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const items = await listMeetingParticipants(deps.db, organizationId, meetingId)
      for (const item of items) assertResponse(deps.registry, SCHEMA.participant, item)
      return { items }
    }
  )
  app.post(
    '/v1/organizations/:organizationId/meeting-participants/:participantTarget',
    (request, reply) => consentParticipantHandler(app, deps, request, reply)
  )
}

async function addParticipantHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, meetingId } = request.params as {
    organizationId: string
    meetingId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, PERM_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(meetingId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.participantAdd, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid participant add')
  const body = request.body as {
    userId: string
    role?: 'host' | 'co_host' | 'presenter' | 'participant'
  }
  if (body.role === 'host') {
    const meeting = await getMeeting(deps.db, organizationId, meetingId)
    if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
    if (meeting.hostUserId !== body.userId) {
      return problem(reply, request, 422, 'HOST_PROTECTED', 'only the designated host can be host')
    }
  }
  const result = await addMeetingParticipant(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    meetingId,
    userId: body.userId,
    ...(body.role ? { role: body.role } : {})
  })
  if (!result.ok) {
    if (result.reason === 'meeting_not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
    return problem(reply, request, 409, 'ALREADY_ADDED', 'participant already in this meeting')
  }
  assertResponse(deps.registry, SCHEMA.participant, result.participant)
  void reply.code(201).header('etag', etag('meeting-participant', result.participant.version))
  return result.participant
}

async function consentParticipantHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, participantTarget } = request.params as {
    organizationId: string
    participantTarget: string
  }
  const { id: participantId, action } = parseTarget(participantTarget)
  if (action !== 'consent')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown participant action')
  const auth = await guard(deps, app, request, reply, organizationId, PERM_READ)
  if (!auth) return reply
  if (!UUID_PATTERN.test(participantId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.participantConsent, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid participant consent')
  const expectedVersion = ifMatchVersion(request, 'meeting-participant')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const { consent } = (request.body ?? {}) as { consent?: boolean }
  const result = await setMeetingParticipantConsent(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    participantId,
    expectedVersion,
    consent: consent ?? true
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'participant not found')
    if (result.reason === 'participant_user_mismatch')
      return problem(
        reply,
        request,
        403,
        'FORBIDDEN',
        'recording consent can only be changed by that participant'
      )
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'participant modified concurrently')
  }
  if (consent === false && deps.media) {
    try {
      await stopActiveMeetingCapture(
        { db: deps.db, media: deps.media },
        {
          organizationId,
          meetingId: result.participant.meetingId,
          actorUserId: auth.userId,
          status: 'paused',
          captureType: 'recording'
        }
      )
    } catch (error) {
      // Legacy clients still use this endpoint, so their withdrawal must trigger the same teardown.
      request.log.error({ err: error }, 'failed to stop capture after legacy consent withdrawal')
    }
  }
  assertResponse(deps.registry, SCHEMA.participant, result.participant)
  void reply.header('etag', etag('meeting-participant', result.participant.version))
  return result.participant
}

// === recordings ===
function registerRecordingRoutes(app: FastifyInstance, deps: MeetingRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/meetings/:meetingId/recordings', (request, reply) =>
    startRecordingHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/recordings',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, PERM_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const items = await listMeetingRecordings(deps.db, organizationId, meetingId)
      for (const item of items) assertResponse(deps.registry, SCHEMA.recording, item)
      return { items }
    }
  )
  app.get(
    '/v1/organizations/:organizationId/meeting-recordings/:recordingId/playback',
    (request, reply) => recordingPlaybackHandler(app, deps, request, reply)
  )
  app.post(
    '/v1/organizations/:organizationId/meeting-recordings/:recordingTarget',
    (request, reply) => finalizeRecordingHandler(app, deps, request, reply)
  )
}

async function startRecordingHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, meetingId } = request.params as {
    organizationId: string
    meetingId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, PERM_MANAGE)
  if (!auth) return reply
  if (!deps.media) {
    return problem(reply, request, 503, 'MEDIA_UNAVAILABLE', 'meeting media is unavailable')
  }
  if (!UUID_PATTERN.test(meetingId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  const body = (request.body ?? {}) as {
    captureTypes?: Array<Extract<MeetingCaptureType, 'recording' | 'transcription' | 'ai_notes'>>
  }
  if (!validates(deps.registry, SCHEMA.recordingStart, body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid recording start')
  const captureTypes: Array<'recording' | 'transcription' | 'ai_notes'> = body.captureTypes ?? [
    'recording',
    'transcription',
    'ai_notes'
  ]
  const result = await startMeetingRecording(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    meetingId,
    captureTypes
  })
  if (!result.ok) {
    if (result.reason === 'meeting_not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
    if (result.reason === 'meeting_not_live')
      return problem(reply, request, 409, 'MEETING_NOT_LIVE', 'meeting is not live')
    if (result.reason === 'no_joined_participants')
      return problem(
        reply,
        request,
        409,
        'MEETING_EMPTY',
        'recording requires at least one joined participant'
      )
    if (result.reason === 'active_recording')
      return problem(
        reply,
        request,
        409,
        'RECORDING_ALREADY_ACTIVE',
        'this meeting already has an active recording'
      )
    // recording-needs-consent: refuse to start while any joined participant has not consented.
    return problem(
      reply,
      request,
      422,
      'CONSENT_REQUIRED',
      'every joined participant must grant recording consent before recording may start'
    )
  }
  try {
    const roomName = meetingMediaRoomName(organizationId, meetingId)
    const session = await deps.media.startRecording({
      roomName,
      organizationId,
      meetingId,
      recordingId: result.recording.id,
      captureTypes
    })
    const attached = await attachMeetingRecordingMedia(deps.db, {
      organizationId,
      actorUserId: auth.userId,
      recordingId: result.recording.id,
      expectedVersion: result.recording.version,
      ...session
    })
    if (!attached) {
      await deps.media.stopRecording({ roomName, ...session })
      throw new Error('recording changed before media attachment')
    }
    assertResponse(deps.registry, SCHEMA.recording, attached)
    await setMeetingCaptureStatus(deps.db, {
      organizationId,
      meetingId,
      actorUserId: auth.userId,
      status: 'active',
      captureTypes
    })
    void reply
      .code(201)
      .header('etag', etag('meeting-recording', attached.version))
      .header('location', `/v1/organizations/${organizationId}/meeting-recordings/${attached.id}`)
    return attached
  } catch (error) {
    request.log.error({ err: error }, 'failed to start LiveKit recording egress')
    await failMeetingRecordingStart(deps.db, {
      organizationId,
      actorUserId: auth.userId,
      recordingId: result.recording.id,
      errorCode: 'MEDIA_EGRESS_START_FAILED'
    })
    return problem(reply, request, 503, 'RECORDING_UNAVAILABLE', 'recording is unavailable')
  }
}

async function finalizeRecordingHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, recordingTarget } = request.params as {
    organizationId: string
    recordingTarget: string
  }
  const { id: recordingId, action } = parseTarget(recordingTarget)
  if (action === 'stop') {
    return stopRecordingHandler(app, deps, request, reply, organizationId, recordingId)
  }
  if (action !== 'finalize')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown recording action')
  const auth = await guard(deps, app, request, reply, organizationId, PERM_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(recordingId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.recordingFinalize, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid recording finalize')
  const expectedVersion = ifMatchVersion(request, 'meeting-recording')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = request.body as { objectRef: string; durationSeconds: number; failed?: boolean }
  const result = await finalizeMeetingRecording(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    recordingId,
    expectedVersion,
    objectRef: body.objectRef,
    durationSeconds: body.durationSeconds,
    ...(body.failed === undefined ? {} : { failed: body.failed })
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'recording not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'recording modified concurrently')
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot finalize a recording in ${result.from}`
    )
  }
  assertResponse(deps.registry, SCHEMA.recording, result.recording)
  void reply.header('etag', etag('meeting-recording', result.recording.version))
  return result.recording
}

async function stopRecordingHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  recordingId: string
): Promise<unknown> {
  const auth = await guard(deps, app, request, reply, organizationId, PERM_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(recordingId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!deps.media)
    return problem(reply, request, 503, 'MEDIA_UNAVAILABLE', 'meeting media is unavailable')
  const recording = await getMeetingRecordingControlState(deps.db, organizationId, recordingId)
  if (!recording) return problem(reply, request, 404, 'NOT_FOUND', 'recording not found')
  if (recording.status !== 'pending')
    return problem(reply, request, 409, 'RECORDING_NOT_ACTIVE', 'recording is not active')
  try {
    await deps.media.stopRecording({
      roomName: meetingMediaRoomName(organizationId, recording.meetingId),
      videoEgressId: recording.videoEgressId,
      audioEgressId: recording.audioEgressId,
      transcriptionDispatchId: recording.transcriptionDispatchId
    })
  } catch (error) {
    request.log.error({ err: error }, 'failed to stop LiveKit recording egress')
    return problem(reply, request, 503, 'RECORDING_UNAVAILABLE', 'recording could not be stopped')
  }
  const updated = await markMeetingRecordingStopped(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    recordingId
  })
  if (!updated)
    return problem(reply, request, 409, 'RECORDING_NOT_ACTIVE', 'recording is not active')
  await setMeetingCaptureStatus(deps.db, {
    organizationId,
    meetingId: recording.meetingId,
    actorUserId: auth.userId,
    status: 'stopped',
    captureTypes: []
  })
  assertResponse(deps.registry, SCHEMA.recording, updated)
  void reply.header('etag', etag('meeting-recording', updated.version))
  return updated
}

async function recordingPlaybackHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, recordingId } = request.params as {
    organizationId: string
    recordingId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, PERM_READ)
  if (!auth) return reply
  if (!UUID_PATTERN.test(recordingId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!deps.objectStorage)
    return problem(reply, request, 503, 'STORAGE_UNAVAILABLE', 'recording storage is unavailable')
  const recording = await getMeetingRecording(deps.db, organizationId, recordingId)
  if (!recording) return problem(reply, request, 404, 'NOT_FOUND', 'recording not found')
  if (recording.status !== 'available' || !recording.objectRef)
    return problem(reply, request, 409, 'RECORDING_NOT_AVAILABLE', 'recording is not available')
  const key = `${createTenantObjectKeyBuilder(organizationId).keyForObject(
    'recordings',
    recording.objectRef
  )}.mp4`
  const response = {
    url: await deps.objectStorage.presignGet(key, { expiresInSeconds: 300 }),
    expiresAt: new Date(Date.now() + 300_000).toISOString()
  }
  assertResponse(deps.registry, SCHEMA.recordingPlayback, response)
  return response
}

function registerProcessingJobRoutes(app: FastifyInstance, deps: MeetingRoutesDeps): void {
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/processing-jobs',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, PERM_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const items = await listMeetingProcessingJobs(deps.db, organizationId, meetingId)
      for (const item of items) assertResponse(deps.registry, SCHEMA.processingJob, item)
      return { items }
    }
  )
}

// === transcripts ===
function registerTranscriptRoutes(app: FastifyInstance, deps: MeetingRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/meetings/:meetingId/transcripts', (request, reply) =>
    createTranscriptHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/transcripts',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, PERM_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const items = await listMeetingTranscripts(deps.db, organizationId, meetingId)
      for (const item of items) assertResponse(deps.registry, SCHEMA.transcript, item)
      return { items }
    }
  )
}

async function createTranscriptHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, meetingId } = request.params as {
    organizationId: string
    meetingId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, PERM_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(meetingId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.transcriptCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transcript create')
  const body = request.body as {
    source: TranscriptSource
    content?: string
    segments?: unknown
    language?: string
  }
  const result = await createMeetingTranscript(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    meetingId,
    source: body.source,
    content: body.content ?? null,
    ...(body.segments === undefined ? {} : { segments: body.segments }),
    language: body.language ?? null
  })
  if (!result.ok) {
    if (result.reason === 'meeting_not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
    return problem(
      reply,
      request,
      400,
      'VALIDATION_FAILED',
      'a transcript requires content or segments'
    )
  }
  assertResponse(deps.registry, SCHEMA.transcript, result.transcript)
  void reply.code(201).header('etag', etag('meeting-transcript', result.transcript.version))
  return result.transcript
}

// === minutes ===
function registerMinutesRoutes(app: FastifyInstance, deps: MeetingRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/meetings/:meetingId/minutes', (request, reply) =>
    createMinutesHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/minutes',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, PERM_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const items = await listMeetingMinutes(deps.db, organizationId, meetingId)
      for (const item of items) assertResponse(deps.registry, SCHEMA.minutes, item)
      return { items }
    }
  )
  app.get(
    '/v1/organizations/:organizationId/meeting-minutes/:minutesId',
    async (request, reply) => {
      const { organizationId, minutesId } = request.params as {
        organizationId: string
        minutesId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, PERM_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(minutesId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const minutes = await getMeetingMinutes(deps.db, organizationId, minutesId)
      if (!minutes) return problem(reply, request, 404, 'NOT_FOUND', 'minutes not found')
      assertResponse(deps.registry, SCHEMA.minutes, minutes)
      void reply.header('etag', etag('meeting-minutes', minutes.version))
      return minutes
    }
  )
  app.post('/v1/organizations/:organizationId/meeting-minutes/:minutesTarget', (request, reply) =>
    minutesActionHandler(app, deps, request, reply)
  )
}

async function createMinutesHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, meetingId } = request.params as {
    organizationId: string
    meetingId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, PERM_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(meetingId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.minutesCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid minutes create')
  const body = request.body as { summary: string; sourceType?: 'manual' | 'ai' }
  const result = await createMeetingMinutes(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    meetingId,
    summary: body.summary,
    ...(body.sourceType ? { sourceType: body.sourceType } : {})
  })
  if (!result.ok) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
  assertResponse(deps.registry, SCHEMA.minutes, result.minutes)
  void reply.code(201).header('etag', etag('meeting-minutes', result.minutes.version))
  return result.minutes
}

async function minutesActionHandler(
  app: FastifyInstance,
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, minutesTarget } = request.params as {
    organizationId: string
    minutesTarget: string
  }
  const { id: minutesId, action } = parseTarget(minutesTarget)
  if (action !== 'review' && action !== 'finalize')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown minutes action')
  // review is the reviewer gate (meeting.minutes.review); finalize stays on meeting.manage.
  const auth = await guard(
    deps,
    app,
    request,
    reply,
    organizationId,
    action === 'review' ? PERM_MINUTES_REVIEW : PERM_MANAGE
  )
  if (!auth) return reply
  if (!UUID_PATTERN.test(minutesId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  const expectedVersion = ifMatchVersion(request, 'meeting-minutes')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  if (action === 'review')
    return reviewMinutesHandler(deps, request, reply, {
      organizationId,
      actorUserId: auth.userId,
      minutesId,
      expectedVersion
    })
  return finalizeMinutesHandler(deps, request, reply, {
    organizationId,
    actorUserId: auth.userId,
    minutesId,
    expectedVersion
  })
}

async function reviewMinutesHandler(
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  base: { organizationId: string; actorUserId: string; minutesId: string; expectedVersion: number }
): Promise<unknown> {
  if (!validates(deps.registry, SCHEMA.minutesReview, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid minutes review')
  const { decision } = (request.body ?? {}) as { decision?: MinutesReviewDecision }
  if (decision !== 'approve' && decision !== 'reject')
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'decision must be approve or reject')
  const result = await reviewMeetingMinutes(deps.db, { ...base, decision })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'minutes not found')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'minutes modified concurrently')
  }
  assertResponse(deps.registry, SCHEMA.minutes, result.minutes)
  void reply.header('etag', etag('meeting-minutes', result.minutes.version))
  return result.minutes
}

async function finalizeMinutesHandler(
  deps: MeetingRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  base: { organizationId: string; actorUserId: string; minutesId: string; expectedVersion: number }
): Promise<unknown> {
  const result = await finalizeMeetingMinutes(deps.db, base)
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'minutes not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'minutes modified concurrently')
    if (result.reason === 'review_required')
      // THE exit condition: unreviewed AI minutes cannot be finalized — human approval is required.
      return problem(
        reply,
        request,
        422,
        'MINUTES_REVIEW_REQUIRED',
        'AI-authored minutes must be human-reviewed and approved before finalize'
      )
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot finalize minutes in ${result.from}`
    )
  }
  assertResponse(deps.registry, SCHEMA.minutes, result.minutes)
  void reply.header('etag', etag('meeting-minutes', result.minutes.version))
  return result.minutes
}
