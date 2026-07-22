import {
  getMeetingDecision,
  listMeetingDecisions,
  reviewMeetingDecision,
  updateMeetingDecision,
  type MeetingDecisionResource,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency, type IdempotencyGate } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCHEMA = {
  decision: 'https://schemas.pielab.ai/resources/meeting-decision.v1.schema.json',
  update: 'https://schemas.pielab.ai/resources/meeting-decision-update.v1.schema.json',
  review: 'https://schemas.pielab.ai/resources/meeting-outcome-review.v1.schema.json'
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

function assertDecision(registry: ContractSchemaRegistry, decision: MeetingDecisionResource): void {
  if (!validates(registry, SCHEMA.decision, decision)) {
    throw new Error('meeting decision response violates its contract')
  }
}

async function authorize(
  app: FastifyInstance,
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  permission: 'meeting.read' | 'meeting.manage' | 'meeting.minutes.review'
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

function expectedVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"meeting-decision-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

function parseReviewTarget(target: string): string | null {
  const suffix = ':review'
  return target.endsWith(suffix) ? target.slice(0, -suffix.length) : null
}

async function replayDecision(
  deps: Deps,
  reply: FastifyReply,
  organizationId: string,
  gate: IdempotencyGate
): Promise<MeetingDecisionResource | null> {
  if (!gate.priorResourceId) return null
  const prior = await getMeetingDecision(deps.db, organizationId, gate.priorResourceId)
  if (!prior) return null
  assertDecision(deps.registry, prior)
  void reply.header('etag', `"meeting-decision-${prior.version}"`)
  return prior
}

function mutationFailure(
  reply: FastifyReply,
  request: FastifyRequest,
  reason: 'not_found' | 'version_conflict' | 'evidence_not_found' | 'empty'
): FastifyReply {
  if (reason === 'not_found') return problem(reply, request, 404, 'NOT_FOUND', 'decision not found')
  if (reason === 'version_conflict') {
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'decision modified concurrently')
  }
  if (reason === 'evidence_not_found') {
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'evidence is from another meeting')
  }
  return problem(reply, request, 400, 'VALIDATION_FAILED', 'decision statement is required')
}

export function registerMeetingDecisionRoutes(app: FastifyInstance, deps: Deps): void {
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/decisions',
    async (request, reply) => {
      const { organizationId, meetingId } = request.params as {
        organizationId: string
        meetingId: string
      }
      if (!(await authorize(app, deps, request, reply, organizationId, 'meeting.read')))
        return reply
      if (!UUID_PATTERN.test(meetingId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      }
      const items = await listMeetingDecisions(deps.db, organizationId, meetingId)
      for (const item of items) assertDecision(deps.registry, item)
      return { items }
    }
  )

  app.patch(
    '/v1/organizations/:organizationId/meeting-decisions/:decisionId',
    async (request, reply) => {
      const { organizationId, decisionId } = request.params as {
        organizationId: string
        decisionId: string
      }
      const auth = await authorize(app, deps, request, reply, organizationId, 'meeting.manage')
      if (!auth) return reply
      if (!UUID_PATTERN.test(decisionId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid decision id')
      }
      if (!validates(deps.registry, SCHEMA.update, request.body)) {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid decision update')
      }
      const version = expectedVersion(request)
      if (version === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: auth.userId,
          method: 'PATCH',
          route: '/v1/organizations/{organizationId}/meeting-decisions/{decisionId}'
        },
        request.body
      )
      if (!gate) return reply
      const prior = await replayDecision(deps, reply, organizationId, gate)
      if (prior) return prior
      const body = request.body as {
        statement: string
        ownerUserId?: string | null
        evidenceSegmentId?: string | null
      }
      const result = await updateMeetingDecision(deps.db, {
        organizationId,
        decisionId,
        actorUserId: auth.userId,
        expectedVersion: version,
        statement: body.statement,
        ownerUserId: body.ownerUserId ?? null,
        evidenceSegmentId: body.evidenceSegmentId ?? null
      })
      if (!result.ok) {
        await gate.release()
        return mutationFailure(reply, request, result.reason)
      }
      await gate.complete(result.decision.id)
      assertDecision(deps.registry, result.decision)
      void reply.header('etag', `"meeting-decision-${result.decision.version}"`)
      return result.decision
    }
  )

  app.post(
    '/v1/organizations/:organizationId/meeting-decisions/:decisionTarget',
    async (request, reply) => {
      const { organizationId, decisionTarget } = request.params as {
        organizationId: string
        decisionTarget: string
      }
      const decisionId = parseReviewTarget(decisionTarget)
      const auth = await authorize(
        app,
        deps,
        request,
        reply,
        organizationId,
        'meeting.minutes.review'
      )
      if (!auth) return reply
      if (!decisionId || !UUID_PATTERN.test(decisionId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid decision id')
      }
      if (!validates(deps.registry, SCHEMA.review, request.body)) {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid decision review')
      }
      const version = expectedVersion(request)
      if (version === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: auth.userId,
          method: 'POST',
          route: '/v1/organizations/{organizationId}/meeting-decisions/{decisionId}:review'
        },
        request.body
      )
      if (!gate) return reply
      const prior = await replayDecision(deps, reply, organizationId, gate)
      if (prior) return prior
      const result = await reviewMeetingDecision(deps.db, {
        organizationId,
        decisionId,
        actorUserId: auth.userId,
        expectedVersion: version,
        decision: (request.body as { decision: 'approve' | 'reject' }).decision
      })
      if (!result.ok) {
        await gate.release()
        return mutationFailure(reply, request, result.reason)
      }
      await gate.complete(result.decision.id)
      assertDecision(deps.registry, result.decision)
      void reply.header('etag', `"meeting-decision-${result.decision.version}"`)
      return result.decision
    }
  )
}
