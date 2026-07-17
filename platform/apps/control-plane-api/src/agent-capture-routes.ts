import {
  searchSessionEvidence,
  setProjectDefaultCaptureMode,
  setSessionCaptureMode,
  type CaptureMode,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolveReadScope } from './agent-read-scope'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

// R5 slice 5a: the scoped EVIDENCE SEARCH read + the capture-policy mutations (session capture
// mode, project default). Split from agent-session-routes so each file stays one responsibility.

const EVIDENCE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-session-evidence.v1.schema.json'
const AGENT_SESSION_SCHEMA_ID = 'https://schemas.pielab.ai/resources/agent-session.v1.schema.json'
const CAPTURE_UPDATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-capture-mode-update.v1.schema.json'
const PROJECT_CAPTURE_POLICY_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-project-capture-policy.v1.schema.json'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CAPTURE_MODES = new Set<CaptureMode>(['full', 'metadata_only', 'paused'])

export type AgentCaptureRoutesDeps = {
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

function sessionEtag(version: number): string {
  return `"agent-session-${version}"`
}

function projectEtag(version: number): string {
  return `"project-${version}"`
}

function ifMatchVersion(request: FastifyRequest, prefix: string): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? new RegExp(`^"${prefix}-(\\d+)"$`).exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

function sessionToWire(session: {
  id: string
  organizationId: string
  workItemId: string | null
  provider: string
  providerSessionId: string | null
  hostId: string
  launchId: string | null
  status: string
  visibility: string
  classification: string
  captureMode: string
  createdBy: string
  version: number
  createdAt: string
  updatedAt: string
}): Record<string, unknown> {
  return {
    id: session.id,
    organizationId: session.organizationId,
    workItemId: session.workItemId,
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    hostId: session.hostId,
    launchId: session.launchId,
    status: session.status,
    visibility: session.visibility,
    classification: session.classification,
    captureMode: session.captureMode,
    createdBy: session.createdBy,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }
}

function registerEvidence(app: FastifyInstance, deps: AgentCaptureRoutesDeps): void {
  // Scoped Evidence search over the append-only event log. agent_session.read gate; the scope
  // resolver caps what is returned so internal prompts / restricted tool output never appear.
  app.get(
    '/v1/organizations/:organizationId/agent-sessions/:sessionId/evidence',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) {
        return reply
      }
      const { organizationId, sessionId } = request.params as {
        organizationId: string
        sessionId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(sessionId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
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
      const query = request.query as { scope?: string; q?: string; cursor?: string; limit?: string }
      const limit = query.limit ? Number(query.limit) : undefined
      const scope = await resolveReadScope(deps.db, principal, organizationId, query.scope)
      const evidence = await searchSessionEvidence(deps.db, organizationId, sessionId, {
        scope,
        ...(query.q ? { q: query.q } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {})
      })
      if (!evidence) {
        return problem(reply, request, 404, 'NOT_FOUND', 'agent session not found')
      }
      const wire = {
        session: sessionToWire(evidence.session),
        scope: evidence.scope,
        items: evidence.items,
        nextCursor: evidence.nextCursor
      }
      assertResponse(deps.registry, EVIDENCE_SCHEMA_ID, wire)
      return wire
    }
  )
}

async function handleSetSessionCaptureMode(
  deps: AgentCaptureRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  sessionId: string,
  actorUserId: string,
  expectedVersion: number
): Promise<unknown> {
  if (!validates(deps.registry, CAPTURE_UPDATE_SCHEMA_ID, request.body)) {
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid capture-mode request')
  }
  const body = request.body as { captureMode: CaptureMode }
  if (!CAPTURE_MODES.has(body.captureMode)) {
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid capture mode')
  }
  const result = await setSessionCaptureMode(deps.db, {
    organizationId,
    sessionId,
    actorUserId,
    captureMode: body.captureMode,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found') {
      return problem(reply, request, 404, 'NOT_FOUND', 'agent session not found')
    }
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'session was modified concurrently')
  }
  const wire = sessionToWire(result.session)
  assertResponse(deps.registry, AGENT_SESSION_SCHEMA_ID, wire)
  void reply.header('etag', sessionEtag(result.session.version))
  return wire
}

async function handleSetProjectDefault(
  deps: AgentCaptureRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  projectId: string,
  actorUserId: string,
  expectedVersion: number
): Promise<unknown> {
  if (!validates(deps.registry, CAPTURE_UPDATE_SCHEMA_ID, request.body)) {
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid capture-mode request')
  }
  const body = request.body as { captureMode: CaptureMode }
  if (!CAPTURE_MODES.has(body.captureMode)) {
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid capture mode')
  }
  const result = await setProjectDefaultCaptureMode(deps.db, {
    organizationId,
    projectId,
    actorUserId,
    captureMode: body.captureMode,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found') {
      return problem(reply, request, 404, 'NOT_FOUND', 'project not found')
    }
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'project was modified concurrently')
  }
  const wire = {
    projectId: result.projectId,
    defaultCaptureMode: result.defaultCaptureMode,
    version: result.version
  }
  assertResponse(deps.registry, PROJECT_CAPTURE_POLICY_SCHEMA_ID, wire)
  void reply.header('etag', projectEtag(result.version))
  return wire
}

// find-my-way cannot parse a param immediately followed by a literal ':' suffix, so the whole
// `{id}:set-capture-mode` token is one param split here (mirrors the intake :assign custom method).
function splitCustomMethod(token: string): { id: string; action: string } {
  const colon = token.lastIndexOf(':')
  return colon === -1
    ? { id: token, action: '' }
    : { id: token.slice(0, colon), action: token.slice(colon + 1) }
}

function registerSessionCaptureMode(app: FastifyInstance, deps: AgentCaptureRoutesDeps): void {
  // agent_capture.manage gate; If-Match OCC (428 if absent). Audited + emits an invalidation.
  app.post(
    '/v1/organizations/:organizationId/agent-sessions/:sessionTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) {
        return reply
      }
      const { organizationId, sessionTarget } = request.params as {
        organizationId: string
        sessionTarget: string
      }
      const { id: sessionId, action } = splitCustomMethod(sessionTarget)
      if (action !== 'set-capture-mode') {
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown session action')
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(sessionId)) {
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
      const expectedVersion = ifMatchVersion(request, 'agent-session')
      if (expectedVersion === null) {
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      }
      return handleSetSessionCaptureMode(
        deps,
        request,
        reply,
        organizationId,
        sessionId,
        authz.userId,
        expectedVersion
      )
    }
  )
}

function registerProjectCaptureDefault(app: FastifyInstance, deps: AgentCaptureRoutesDeps): void {
  // The project-level default a new session inherits. agent_capture.manage gate; If-Match OCC.
  app.post('/v1/organizations/:organizationId/projects/:projectTarget', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    const { organizationId, projectTarget } = request.params as {
      organizationId: string
      projectTarget: string
    }
    const { id: projectId, action } = splitCustomMethod(projectTarget)
    if (action !== 'set-capture-mode') {
      return problem(reply, request, 404, 'NOT_FOUND', 'unknown project action')
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId)) {
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
    const expectedVersion = ifMatchVersion(request, 'project')
    if (expectedVersion === null) {
      return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
    }
    return handleSetProjectDefault(
      deps,
      request,
      reply,
      organizationId,
      projectId,
      authz.userId,
      expectedVersion
    )
  })
}

export function registerAgentCaptureRoutes(
  app: FastifyInstance,
  deps: AgentCaptureRoutesDeps
): void {
  registerEvidence(app, deps)
  registerSessionCaptureMode(app, deps)
  registerProjectCaptureDefault(app, deps)
}
