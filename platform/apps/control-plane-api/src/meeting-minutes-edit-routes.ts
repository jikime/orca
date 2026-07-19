import {
  listMeetingMinutesRevisions,
  updateMeetingMinutesDraft,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const SCHEMA = {
  minutes: 'https://schemas.pielab.ai/resources/meeting-minutes.v1.schema.json',
  update: 'https://schemas.pielab.ai/resources/meeting-minutes-update.v1.schema.json',
  revision: 'https://schemas.pielab.ai/resources/meeting-minutes-revision.v1.schema.json'
} as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type MeetingMinutesEditDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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
  deps: MeetingMinutesEditDeps,
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
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    permission
  )
  return authz ? { userId: authz.userId ?? organizationId } : null
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"meeting-minutes-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

function validates(deps: MeetingMinutesEditDeps, schemaId: string, body: unknown): boolean {
  const validate = deps.registry.ajv.getSchema(schemaId)
  return !validate || validate(body) === true
}

export function registerMeetingMinutesEditRoutes(
  app: FastifyInstance,
  deps: MeetingMinutesEditDeps
): void {
  app.patch(
    '/v1/organizations/:organizationId/meeting-minutes/:minutesId',
    async (request, reply) => {
      const { organizationId, minutesId } = request.params as {
        organizationId: string
        minutesId: string
      }
      const auth = await guard(app, deps, request, reply, organizationId, 'meeting.manage')
      if (!auth) return reply
      if (!UUID_PATTERN.test(minutesId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid minutes id')
      }
      if (!validates(deps, SCHEMA.update, request.body)) {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid minutes update')
      }
      const expectedVersion = ifMatchVersion(request)
      if (expectedVersion === null) {
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      }
      const result = await updateMeetingMinutesDraft(deps.db, {
        organizationId,
        minutesId,
        actorUserId: auth.userId,
        expectedVersion,
        summary: (request.body as { summary: string }).summary
      })
      if (!result.ok) {
        if (result.reason === 'not_found') {
          return problem(reply, request, 404, 'NOT_FOUND', 'minutes not found')
        }
        if (result.reason === 'version_conflict') {
          return problem(reply, request, 409, 'VERSION_CONFLICT', 'minutes modified concurrently')
        }
        return problem(reply, request, 409, 'ILLEGAL_TRANSITION', 'finalized minutes are read-only')
      }
      if (!validates(deps, SCHEMA.minutes, result.minutes)) {
        throw new Error('meeting minutes response violates its contract')
      }
      return reply
        .header('etag', `"meeting-minutes-${result.minutes.version}"`)
        .send(result.minutes)
    }
  )

  app.get(
    '/v1/organizations/:organizationId/meeting-minutes/:minutesId/revisions',
    async (request, reply) => {
      const { organizationId, minutesId } = request.params as {
        organizationId: string
        minutesId: string
      }
      const auth = await guard(app, deps, request, reply, organizationId, 'meeting.read')
      if (!auth) return reply
      if (!UUID_PATTERN.test(minutesId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid minutes id')
      }
      const items = await listMeetingMinutesRevisions(deps.db, organizationId, minutesId)
      for (const item of items) {
        if (!validates(deps, SCHEMA.revision, item)) {
          throw new Error('meeting minutes revision response violates its contract')
        }
      }
      return { items }
    }
  )
}
