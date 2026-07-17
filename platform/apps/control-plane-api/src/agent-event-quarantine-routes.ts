import {
  listAgentEventQuarantine,
  resolveQuarantine,
  type AgentEventQuarantine,
  type PieDatabase,
  type QuarantineStatus,
  type ResolveQuarantineAction
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const QUARANTINE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-event-quarantine.v1.schema.json'
const QUARANTINE_LIST_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-event-quarantine-list.v1.schema.json'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AgentEventQuarantineRoutesDeps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
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

function assertResponse(registry: ContractSchemaRegistry, schemaId: string, body: unknown): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${schemaId}`)
  }
}

function quarantineEtag(version: number): string {
  return `"agent-event-quarantine-${version}"`
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"agent-event-quarantine-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

function quarantineToWire(item: AgentEventQuarantine): Record<string, unknown> {
  return {
    id: item.id,
    organizationId: item.organizationId,
    eventId: item.eventId,
    agentSessionId: item.agentSessionId,
    streamId: item.streamId,
    sequence: item.sequence,
    reasonCode: item.reasonCode,
    contentHash: item.contentHash,
    payloadSizeBytes: item.payloadSizeBytes,
    status: item.status,
    resolvedBy: item.resolvedBy,
    resolvedAt: item.resolvedAt,
    version: item.version,
    quarantinedAt: item.quarantinedAt,
    updatedAt: item.updatedAt
  }
}

function registerList(app: FastifyInstance, deps: AgentEventQuarantineRoutesDeps): void {
  // The poison-event quarantine queue (doc 20 OPS-001) for operator visibility, cursor-paged and
  // metadata-only. agent_capture.manage gate — quarantine triage/recovery is an agent-capture
  // management concern, not a general read.
  app.get('/v1/organizations/:organizationId/agent-event-quarantine', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId)) {
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    }
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'agent_capture.manage'
    )
    if (!authz) {
      return reply
    }
    const query = request.query as { status?: string; cursor?: string; limit?: string }
    const limit = query.limit ? Number(query.limit) : undefined
    const page = await listAgentEventQuarantine(deps.db, organizationId, {
      ...(query.status ? { status: query.status as QuarantineStatus } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {})
    })
    const wire = { items: page.items.map(quarantineToWire), nextCursor: page.nextCursor }
    assertResponse(deps.registry, QUARANTINE_LIST_SCHEMA_ID, wire)
    return wire
  })
}

function registerResolve(app: FastifyInstance, deps: AgentEventQuarantineRoutesDeps): void {
  // Operator recovery: discard (drop the poison) or recover (mark handled). agent_capture.manage
  // gate; If-Match OCC (428 if absent). find-my-way cannot parse a param immediately followed by a
  // literal ':' suffix, so the whole `{id}:discard` token is one param split here (mirrors the
  // intake :assign split). Client-facing URL: `.../agent-event-quarantine/{id}:discard`.
  app.post(
    '/v1/organizations/:organizationId/agent-event-quarantine/:quarantineTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) {
        return reply
      }
      const { organizationId, quarantineTarget } = request.params as {
        organizationId: string
        quarantineTarget: string
      }
      const colon = quarantineTarget.lastIndexOf(':')
      const quarantineId = colon === -1 ? quarantineTarget : quarantineTarget.slice(0, colon)
      const action = colon === -1 ? '' : quarantineTarget.slice(colon + 1)
      if (action !== 'discard' && action !== 'recover') {
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown quarantine action')
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(quarantineId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      }
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'agent_capture.manage'
      )
      if (!authz || !authz.userId) {
        return authz ? reply.code(403).send() : reply
      }
      const expectedVersion = ifMatchVersion(request)
      if (expectedVersion === null) {
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      }
      const result = await resolveQuarantine(deps.db, {
        organizationId,
        quarantineId,
        actorUserId: authz.userId,
        action: action as ResolveQuarantineAction,
        expectedVersion
      })
      if (!result.ok) {
        if (result.reason === 'not_found') {
          return problem(reply, request, 404, 'NOT_FOUND', 'quarantine item not found')
        }
        if (result.reason === 'version_conflict') {
          return problem(
            reply,
            request,
            409,
            'VERSION_CONFLICT',
            'quarantine was modified concurrently'
          )
        }
        return problem(
          reply,
          request,
          409,
          'QUARANTINE_TERMINAL',
          `quarantine is already ${result.status} and cannot be resolved`
        )
      }
      const wire = quarantineToWire(result.quarantine)
      assertResponse(deps.registry, QUARANTINE_SCHEMA_ID, wire)
      void reply.header('etag', quarantineEtag(result.quarantine.version))
      return wire
    }
  )
}

export function registerAgentEventQuarantineRoutes(
  app: FastifyInstance,
  deps: AgentEventQuarantineRoutesDeps
): void {
  registerList(app, deps)
  registerResolve(app, deps)
}
