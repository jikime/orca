import {
  assignIntake,
  listAgentSessionIntake,
  reclassifyIntake,
  type AgentSessionIntake,
  type IntakeDetectedReason,
  type IntakeSourceType,
  type IntakeStatus,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const INTAKE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/agent-session-intake.v1.schema.json'
const INTAKE_LIST_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-session-intake-list.v1.schema.json'
const INTAKE_ASSIGN_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-session-intake-assign.v1.schema.json'
const INTAKE_RECLASSIFY_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-session-intake-reclassify.v1.schema.json'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AgentSessionIntakeRoutesDeps = {
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

function validates(registry: ContractSchemaRegistry, schemaId: string, body: unknown): boolean {
  const validate = registry.ajv.getSchema(schemaId)
  return !validate || validate(body) === true
}

function assertResponse(registry: ContractSchemaRegistry, schemaId: string, body: unknown): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${schemaId}`)
  }
}

function intakeEtag(version: number): string {
  return `"agent-session-intake-${version}"`
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"agent-session-intake-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

function intakeToWire(intake: AgentSessionIntake): Record<string, unknown> {
  return {
    id: intake.id,
    organizationId: intake.organizationId,
    agentSessionId: intake.agentSessionId,
    sourceType: intake.sourceType,
    status: intake.status,
    detectedReason: intake.detectedReason,
    hostId: intake.hostId,
    workspaceId: intake.workspaceId,
    provider: intake.provider,
    workItemId: intake.workItemId,
    assignedBy: intake.assignedBy,
    assignedAt: intake.assignedAt,
    version: intake.version,
    createdAt: intake.createdAt,
    updatedAt: intake.updatedAt
  }
}

function registerList(app: FastifyInstance, deps: AgentSessionIntakeRoutesDeps): void {
  // The unassigned-session intake queue, searchable by capture scope (doc 19 :162, doc 24 host
  // scope). agent_session.read gate — reading the queue is a read, assigning it is a mutation.
  app.get('/v1/organizations/:organizationId/agent-session-intake', async (request, reply) => {
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
      'agent_session.read'
    )
    if (!authz) {
      return reply
    }
    const query = request.query as {
      status?: string
      hostId?: string
      workspaceId?: string
      provider?: string
      sourceType?: string
      cursor?: string
      limit?: string
    }
    const limit = query.limit ? Number(query.limit) : undefined
    const page = await listAgentSessionIntake(deps.db, organizationId, {
      ...(query.status ? { status: query.status as IntakeStatus } : {}),
      ...(query.hostId ? { hostId: query.hostId } : {}),
      ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.sourceType ? { sourceType: query.sourceType as IntakeSourceType } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {})
    })
    const wire = { items: page.items.map(intakeToWire), nextCursor: page.nextCursor }
    assertResponse(deps.registry, INTAKE_LIST_SCHEMA_ID, wire)
    return wire
  })
}

async function handleAssign(
  deps: AgentSessionIntakeRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  intakeId: string,
  actorUserId: string,
  expectedVersion: number
): Promise<unknown> {
  if (!validates(deps.registry, INTAKE_ASSIGN_SCHEMA_ID, request.body)) {
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid intake assign request')
  }
  const body = request.body as { workItemId: string }
  const result = await assignIntake(deps.db, {
    organizationId,
    intakeId,
    actorUserId,
    workItemId: body.workItemId,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found') {
      return problem(reply, request, 404, 'NOT_FOUND', 'intake item not found')
    }
    if (result.reason === 'version_conflict') {
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'intake was modified concurrently')
    }
    return problem(
      reply,
      request,
      409,
      'INTAKE_TERMINAL',
      `intake is already ${result.status} and cannot be reassigned`
    )
  }
  const wire = intakeToWire(result.intake)
  assertResponse(deps.registry, INTAKE_SCHEMA_ID, wire)
  void reply.header('etag', intakeEtag(result.intake.version))
  return wire
}

async function handleReclassify(
  deps: AgentSessionIntakeRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  intakeId: string,
  actorUserId: string,
  expectedVersion: number
): Promise<unknown> {
  if (!validates(deps.registry, INTAKE_RECLASSIFY_SCHEMA_ID, request.body)) {
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid intake reclassify request')
  }
  const body = request.body as {
    dismiss?: boolean
    detectedReason?: IntakeDetectedReason
    sourceType?: IntakeSourceType
  }
  const result = await reclassifyIntake(deps.db, {
    organizationId,
    intakeId,
    actorUserId,
    expectedVersion,
    ...(body.dismiss !== undefined ? { dismiss: body.dismiss } : {}),
    ...(body.detectedReason ? { detectedReason: body.detectedReason } : {}),
    ...(body.sourceType ? { sourceType: body.sourceType } : {})
  })
  if (!result.ok) {
    if (result.reason === 'not_found') {
      return problem(reply, request, 404, 'NOT_FOUND', 'intake item not found')
    }
    if (result.reason === 'version_conflict') {
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'intake was modified concurrently')
    }
    return problem(
      reply,
      request,
      409,
      'INTAKE_TERMINAL',
      `intake is already ${result.status} and cannot be reclassified`
    )
  }
  const wire = intakeToWire(result.intake)
  assertResponse(deps.registry, INTAKE_SCHEMA_ID, wire)
  void reply.header('etag', intakeEtag(result.intake.version))
  return wire
}

function registerCustomMethods(app: FastifyInstance, deps: AgentSessionIntakeRoutesDeps): void {
  // Explicit assign / reclassify / dismiss. agent_session.assign gate; If-Match OCC (428 if
  // absent). find-my-way cannot parse a param immediately followed by a literal ':' suffix, so
  // the whole `{intakeId}:assign` token is one param split here (mirrors remote-session
  // :transition). The client-facing URL is `.../agent-session-intake/{intakeId}:assign`.
  app.post(
    '/v1/organizations/:organizationId/agent-session-intake/:intakeTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) {
        return reply
      }
      const { organizationId, intakeTarget } = request.params as {
        organizationId: string
        intakeTarget: string
      }
      const colon = intakeTarget.lastIndexOf(':')
      const intakeId = colon === -1 ? intakeTarget : intakeTarget.slice(0, colon)
      const action = colon === -1 ? '' : intakeTarget.slice(colon + 1)
      if (action !== 'assign' && action !== 'reclassify') {
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown intake action')
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(intakeId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      }
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'agent_session.assign'
      )
      if (!authz || !authz.userId) {
        return authz ? reply.code(403).send() : reply
      }
      const expectedVersion = ifMatchVersion(request)
      if (expectedVersion === null) {
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      }
      if (action === 'assign') {
        return handleAssign(
          deps,
          request,
          reply,
          organizationId,
          intakeId,
          authz.userId,
          expectedVersion
        )
      }
      return handleReclassify(
        deps,
        request,
        reply,
        organizationId,
        intakeId,
        authz.userId,
        expectedVersion
      )
    }
  )
}

export function registerAgentSessionIntakeRoutes(
  app: FastifyInstance,
  deps: AgentSessionIntakeRoutesDeps
): void {
  registerList(app, deps)
  registerCustomMethods(app, deps)
}
