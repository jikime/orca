import {
  auditMeetingGovernanceExport,
  getMeeting,
  getMeetingGovernance,
  listMeetingCaptureConsents,
  listMeetingActionItems,
  listMeetingAgendaItems,
  listMeetingDecisions,
  listMeetingGovernanceAudit,
  listMeetingMinutes,
  listMeetingParticipants,
  listMeetingRecordings,
  listMeetingTranscriptSegments,
  listMeetingTranscripts,
  requestMeetingDeletion,
  setMeetingCaptureConsent,
  updateMeetingGovernance,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'
import type { MeetingMediaService } from './meeting-media-service'
import { stopActiveMeetingCapture } from './meeting-capture-control-routes'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCHEMA = {
  governance: 'https://schemas.pielab.ai/resources/meeting-governance.v1.schema.json',
  governanceUpdate: 'https://schemas.pielab.ai/resources/meeting-governance-update.v1.schema.json',
  consent: 'https://schemas.pielab.ai/resources/meeting-capture-consent.v1.schema.json',
  consentUpdate:
    'https://schemas.pielab.ai/resources/meeting-capture-consent-update.v1.schema.json',
  deletionRequest: 'https://schemas.pielab.ai/resources/meeting-deletion-request.v1.schema.json',
  export: 'https://schemas.pielab.ai/resources/meeting-governance-export.v1.schema.json'
} as const

type Deps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  media?: MeetingMediaService
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

function assertResponse(registry: ContractSchemaRegistry, schemaId: string, body: unknown): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) throw new Error(`response violates contract ${schemaId}`)
}

function ifMatchVersion(request: FastifyRequest, prefix: string): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return null
  const match = new RegExp(`^"${prefix}-(\\d+)"$`).exec(value)
  return match?.[1] ? Number(match[1]) : null
}

async function authorize(
  app: FastifyInstance,
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  permission: 'meeting.read' | 'meeting.manage'
): Promise<{ userId: string } | null> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return null
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

export function registerMeetingGovernanceRoutes(app: FastifyInstance, deps: Deps): void {
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/governance',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      if (!(await authorize(app, deps, request, reply, organizationId, 'meeting.read')))
        return reply
      const governance = await getMeetingGovernance(deps.db, organizationId, meetingId)
      if (!governance) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      assertResponse(deps.registry, SCHEMA.governance, governance)
      void reply.header('etag', `"meeting-governance-${governance.version}"`)
      return governance
    }
  )

  app.patch(
    '/v1/organizations/:organizationId/meetings/:meetingId/governance',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      const auth = await authorize(app, deps, request, reply, organizationId, 'meeting.manage')
      if (!auth) return reply
      if (!validates(deps.registry, SCHEMA.governanceUpdate, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid governance policy')
      const expectedVersion = ifMatchVersion(request, 'meeting-governance')
      if (expectedVersion === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      const body = request.body as {
        purpose?: string
        retentionDays?: number | null
        legalHold?: boolean
      }
      const result = await updateMeetingGovernance(deps.db, {
        organizationId,
        meetingId,
        actorUserId: auth.userId,
        expectedVersion,
        ...body
      })
      if (!result.ok) {
        return result.reason === 'not_found'
          ? problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
          : problem(reply, request, 409, 'VERSION_CONFLICT', 'governance modified concurrently')
      }
      let governance = result.governance
      if (governance.captureStatus === 'active' && deps.media) {
        await stopActiveMeetingCapture(
          { db: deps.db, media: deps.media },
          {
            organizationId,
            meetingId,
            actorUserId: auth.userId,
            status: 'paused'
          }
        )
        governance = (await getMeetingGovernance(deps.db, organizationId, meetingId)) ?? governance
      }
      assertResponse(deps.registry, SCHEMA.governance, governance)
      void reply.header('etag', `"meeting-governance-${governance.version}"`)
      return governance
    }
  )

  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/capture-consents',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      if (!(await authorize(app, deps, request, reply, organizationId, 'meeting.read')))
        return reply
      const items = await listMeetingCaptureConsents(deps.db, organizationId, meetingId)
      for (const item of items) assertResponse(deps.registry, SCHEMA.consent, item)
      return { items }
    }
  )

  app.patch(
    '/v1/organizations/:organizationId/meeting-capture-consents/:consentId',
    async (request, reply) => {
      const { organizationId, consentId } = request.params as {
        organizationId: string
        consentId: string
      }
      if (!UUID_PATTERN.test(consentId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid consent id')
      const auth = await authorize(app, deps, request, reply, organizationId, 'meeting.read')
      if (!auth) return reply
      if (!validates(deps.registry, SCHEMA.consentUpdate, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid capture consent')
      const expectedVersion = ifMatchVersion(request, 'meeting-capture-consent')
      if (expectedVersion === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      const body = request.body as {
        status: 'granted' | 'denied' | 'revoked'
        expiresAt?: string | null
      }
      const result = await setMeetingCaptureConsent(deps.db, {
        organizationId,
        actorUserId: auth.userId,
        consentId,
        expectedVersion,
        status: body.status,
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt })
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'capture consent not found')
        if (result.reason === 'participant_user_mismatch')
          return problem(reply, request, 403, 'FORBIDDEN', 'capture consent is personal')
        return problem(reply, request, 409, 'VERSION_CONFLICT', 'consent modified concurrently')
      }
      if (body.status !== 'granted' && deps.media) {
        try {
          await stopActiveMeetingCapture(
            { db: deps.db, media: deps.media },
            {
              organizationId,
              meetingId: result.consent.meetingId,
              actorUserId: auth.userId,
              status: 'paused',
              captureType: result.consent.captureType
            }
          )
        } catch (error) {
          // Consent is authoritative even if media teardown needs operational retry.
          request.log.error({ err: error }, 'failed to stop capture after consent withdrawal')
        }
      }
      assertResponse(deps.registry, SCHEMA.consent, result.consent)
      void reply.header('etag', `"meeting-capture-consent-${result.consent.version}"`)
      return result.consent
    }
  )

  registerMeetingDeletionAndAuditRoutes(app, deps)
}

function registerMeetingDeletionAndAuditRoutes(app: FastifyInstance, deps: Deps): void {
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/governance-export',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      const auth = await authorize(app, deps, request, reply, organizationId, 'meeting.manage')
      if (!auth) return reply
      const meeting = await getMeeting(deps.db, organizationId, meetingId)
      const governance = await getMeetingGovernance(deps.db, organizationId, meetingId)
      if (!meeting || !governance)
        return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      const [
        participants,
        consents,
        recordings,
        transcripts,
        minutes,
        decisions,
        actionItems,
        agendaItems
      ] = await Promise.all([
        listMeetingParticipants(deps.db, organizationId, meetingId),
        listMeetingCaptureConsents(deps.db, organizationId, meetingId),
        listMeetingRecordings(deps.db, organizationId, meetingId),
        listMeetingTranscripts(deps.db, organizationId, meetingId),
        listMeetingMinutes(deps.db, organizationId, meetingId),
        listMeetingDecisions(deps.db, organizationId, meetingId),
        listMeetingActionItems(deps.db, organizationId, meetingId),
        listMeetingAgendaItems(deps.db, organizationId, meetingId)
      ])
      const transcriptSegments = []
      for (const transcript of transcripts) {
        let cursor: string | null = null
        do {
          const page = await listMeetingTranscriptSegments(deps.db, {
            organizationId,
            transcriptId: transcript.id,
            cursor,
            limit: 200
          })
          if (!page) break
          transcriptSegments.push(...page.items)
          cursor = page.nextCursor
        } while (cursor)
      }
      const result = {
        exportedAt: new Date().toISOString(),
        meeting,
        governance,
        participants,
        consents,
        recordings,
        transcripts,
        transcriptSegments,
        minutes,
        decisions,
        actionItems,
        agendaItems
      }
      await auditMeetingGovernanceExport(deps.db, {
        organizationId,
        meetingId,
        actorUserId: auth.userId
      })
      assertResponse(deps.registry, SCHEMA.export, result)
      return result
    }
  )

  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/governance-audit',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      if (!(await authorize(app, deps, request, reply, organizationId, 'meeting.manage')))
        return reply
      return { items: await listMeetingGovernanceAudit(deps.db, organizationId, meetingId) }
    }
  )

  app.post(
    '/v1/organizations/:organizationId/meetings/:meetingId/deletion-requests',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      const auth = await authorize(app, deps, request, reply, organizationId, 'meeting.manage')
      if (!auth) return reply
      if (!validates(deps.registry, SCHEMA.deletionRequest, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid deletion request')
      const expectedVersion = ifMatchVersion(request, 'meeting-governance')
      if (expectedVersion === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      const body = request.body as { reason: string; confirmation: string }
      const meeting = await getMeeting(deps.db, organizationId, meetingId)
      if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      if (body.confirmation !== meeting.title)
        return problem(reply, request, 400, 'CONFIRMATION_MISMATCH', 'meeting title does not match')
      const result = await requestMeetingDeletion(deps.db, {
        organizationId,
        meetingId,
        actorUserId: auth.userId,
        expectedVersion,
        reason: body.reason
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
        if (result.reason === 'version_conflict')
          return problem(
            reply,
            request,
            409,
            'VERSION_CONFLICT',
            'governance modified concurrently'
          )
        if (result.reason === 'legal_hold')
          return problem(reply, request, 423, 'LEGAL_HOLD', 'meeting is under legal hold')
        if (result.reason === 'meeting_live')
          return problem(reply, request, 409, 'MEETING_LIVE', 'end the meeting before deletion')
        return problem(reply, request, 409, 'ALREADY_DELETED', 'meeting capture is already deleted')
      }
      assertResponse(deps.registry, SCHEMA.governance, result.governance)
      void reply.code(202).header('etag', `"meeting-governance-${result.governance.version}"`)
      return result.governance
    }
  )
}
