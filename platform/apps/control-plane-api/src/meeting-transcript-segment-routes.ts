import {
  correctMeetingTranscriptSegment,
  getMeetingTranscriptSegment,
  listMeetingTranscriptSegmentRevisions,
  listMeetingTranscriptSegments,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCHEMA = {
  segment: 'https://schemas.pielab.ai/resources/meeting-transcript-segment.v1.schema.json',
  update: 'https://schemas.pielab.ai/resources/meeting-transcript-segment-update.v1.schema.json',
  revision: 'https://schemas.pielab.ai/resources/meeting-transcript-segment-revision.v1.schema.json'
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

function assertResponse(registry: ContractSchemaRegistry, schemaId: string, body: unknown): void {
  if (!validates(registry, schemaId, body)) {
    throw new Error(`response violates contract ${schemaId}`)
  }
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

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"meeting-transcript-segment-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export function registerMeetingTranscriptSegmentRoutes(app: FastifyInstance, deps: Deps): void {
  app.get(
    '/v1/organizations/:organizationId/meeting-transcripts/:transcriptId/segments',
    async (request, reply) => {
      const { organizationId, transcriptId } = request.params as {
        organizationId: string
        transcriptId: string
      }
      if (!(await authorize(app, deps, request, reply, organizationId, 'meeting.read'))) {
        return reply
      }
      if (!UUID_PATTERN.test(transcriptId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid transcript id')
      }
      const query = request.query as { cursor?: string; limit?: string; query?: string }
      const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid segment page limit')
      }
      const page = await listMeetingTranscriptSegments(deps.db, {
        organizationId,
        transcriptId,
        cursor: query.cursor ?? null,
        ...(limit === undefined ? {} : { limit }),
        query: query.query ?? null
      })
      if (!page) return problem(reply, request, 404, 'NOT_FOUND', 'transcript not found')
      for (const item of page.items) assertResponse(deps.registry, SCHEMA.segment, item)
      return page
    }
  )

  app.get(
    '/v1/organizations/:organizationId/meeting-transcript-segments/:segmentId',
    async (request, reply) => {
      const { organizationId, segmentId } = request.params as {
        organizationId: string
        segmentId: string
      }
      if (!(await authorize(app, deps, request, reply, organizationId, 'meeting.read'))) {
        return reply
      }
      if (!UUID_PATTERN.test(segmentId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid transcript segment id')
      }
      const segment = await getMeetingTranscriptSegment(deps.db, organizationId, segmentId)
      if (!segment) return problem(reply, request, 404, 'NOT_FOUND', 'transcript segment not found')
      assertResponse(deps.registry, SCHEMA.segment, segment)
      void reply.header('etag', `"meeting-transcript-segment-${segment.version}"`)
      return segment
    }
  )

  app.patch(
    '/v1/organizations/:organizationId/meeting-transcript-segments/:segmentId',
    async (request, reply) => {
      const { organizationId, segmentId } = request.params as {
        organizationId: string
        segmentId: string
      }
      const auth = await authorize(app, deps, request, reply, organizationId, 'meeting.manage')
      if (!auth) return reply
      if (!UUID_PATTERN.test(segmentId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid transcript segment id')
      }
      if (!validates(deps.registry, SCHEMA.update, request.body)) {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid segment correction')
      }
      const expectedVersion = ifMatchVersion(request)
      if (expectedVersion === null) {
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      }
      const body = request.body as {
        speakerLabel: string
        speakerParticipantId?: string | null
        text: string
      }
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: auth.userId,
          method: 'PATCH',
          route: '/v1/organizations/{organizationId}/meeting-transcript-segments/{segmentId}'
        },
        request.body
      )
      if (!gate) return reply
      if (gate.priorResourceId) {
        const prior = await getMeetingTranscriptSegment(
          deps.db,
          organizationId,
          gate.priorResourceId
        )
        if (prior) {
          assertResponse(deps.registry, SCHEMA.segment, prior)
          void reply.header('etag', `"meeting-transcript-segment-${prior.version}"`)
          return prior
        }
      }
      const result = await correctMeetingTranscriptSegment(deps.db, {
        organizationId,
        segmentId,
        actorUserId: auth.userId,
        expectedVersion,
        speakerLabel: body.speakerLabel,
        speakerParticipantId: body.speakerParticipantId ?? null,
        text: body.text
      })
      if (!result.ok) {
        await gate.release()
        if (result.reason === 'not_found') {
          return problem(reply, request, 404, 'NOT_FOUND', 'transcript segment not found')
        }
        if (result.reason === 'version_conflict') {
          return problem(reply, request, 409, 'VERSION_CONFLICT', 'segment modified concurrently')
        }
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'segment text is required')
      }
      assertResponse(deps.registry, SCHEMA.segment, result.segment)
      await gate.complete(result.segment.id)
      void reply.header('etag', `"meeting-transcript-segment-${result.segment.version}"`)
      return result.segment
    }
  )

  app.get(
    '/v1/organizations/:organizationId/meeting-transcript-segments/:segmentId/revisions',
    async (request, reply) => {
      const { organizationId, segmentId } = request.params as {
        organizationId: string
        segmentId: string
      }
      if (!(await authorize(app, deps, request, reply, organizationId, 'meeting.read'))) {
        return reply
      }
      if (!UUID_PATTERN.test(segmentId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid transcript segment id')
      }
      const items = await listMeetingTranscriptSegmentRevisions(deps.db, organizationId, segmentId)
      if (!items) return problem(reply, request, 404, 'NOT_FOUND', 'transcript segment not found')
      for (const item of items) assertResponse(deps.registry, SCHEMA.revision, item)
      return { items }
    }
  )
}
