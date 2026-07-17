import {
  createAgentSession,
  ingestAgentEvents,
  listSessionProvenance,
  listSessionTimeline,
  type AgentEventEnvelope,
  type AgentProvider,
  type AgentSession,
  type CaptureMode,
  type IngestAgentEventsInput,
  type PieDatabase,
  type ResourceClassification,
  type ResourceVisibility,
  type SignedExecutionContext
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { resolveReadScope } from './agent-read-scope'
import { authorizeOrgPermission } from './route-authorization'

const AGENT_SESSION_SCHEMA_ID = 'https://schemas.pielab.ai/resources/agent-session.v1.schema.json'
const AGENT_SESSION_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-session-create.v1.schema.json'
const AGENT_SESSION_TIMELINE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-session-timeline.v1.schema.json'
const AGENT_SESSION_PROVENANCE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/agent-session-provenance.v1.schema.json'
const AGENT_EVENT_BATCH_REQUEST_SCHEMA_ID =
  'https://schemas.pielab.ai/events/agent-event-batch-request.v1.schema.json'
const AGENT_EVENT_BATCH_RESPONSE_SCHEMA_ID =
  'https://schemas.pielab.ai/events/agent-event-batch-response.v1.schema.json'

const AGENT_SESSIONS_ROUTE = '/v1/organizations/{organizationId}/agent-sessions'
const AGENT_EVENTS_BATCH_ROUTE = '/v1/organizations/{organizationId}/agent-events:batch'
// The org-level ingest surface is a static colon-suffixed segment; find-my-way cannot register
// `agent-events:batch` literally, so we capture the 3rd segment and match the token here (mirrors
// the remote-session `:transition` split). The client-facing URL stays `.../agent-events:batch`.
const AGENT_EVENTS_BATCH_TOKEN = 'agent-events:batch'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AgentSessionRoutesDeps = {
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

function sessionToWire(session: AgentSession): Record<string, unknown> {
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

type CreateBody = {
  provider: AgentProvider
  hostId: string
  providerSessionId?: string
  launchId?: string
  workItemId?: string
  visibility?: ResourceVisibility
  classification?: ResourceClassification
  captureMode?: CaptureMode
}

type BatchBody = {
  batchId: string
  producerId: string
  protocolVersion: '1.0'
  events: AgentEventEnvelope[]
  clientCheckpoint: { streamId: string; lastServerAck: number }
  // R5 s2b: optional signed ExecutionContext that binds the batch to one signed session.
  executionContext?: SignedExecutionContext
  // R5 s5: optional per-batch one-time-use nonce (anti-replay), enforced only with a context.
  submissionNonce?: string
}

function registerCreateSession(app: FastifyInstance, deps: AgentSessionRoutesDeps): void {
  // Opens an agent session that ingested events bind to. agent_event.ingest gate; the capture
  // producer creates the session it will feed. Idempotency-Key required; 201 + Location.
  app.post('/v1/organizations/:organizationId/agent-sessions', async (request, reply) => {
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
      'agent_event.ingest'
    )
    if (!authz || !authz.userId) {
      return authz ? reply.code(403).send() : reply
    }
    if (!validates(deps.registry, AGENT_SESSION_CREATE_SCHEMA_ID, request.body)) {
      return problem(
        reply,
        request,
        400,
        'VALIDATION_FAILED',
        'invalid agent session create request'
      )
    }
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      {
        organizationId,
        principalId: principal.subject,
        method: 'POST',
        route: AGENT_SESSIONS_ROUTE
      },
      request.body
    )
    if (!gate) {
      return reply
    }
    const respond = (session: AgentSession, created: boolean): Record<string, unknown> => {
      const wire = sessionToWire(session)
      assertResponse(deps.registry, AGENT_SESSION_SCHEMA_ID, wire)
      void reply
        .code(created ? 201 : 200)
        .header('location', `/v1/organizations/${organizationId}/agent-sessions/${session.id}`)
      return wire
    }
    if (gate.priorResourceId) {
      const existing = await getExistingSession(deps, organizationId, gate.priorResourceId)
      if (!existing) {
        return problem(reply, request, 404, 'NOT_FOUND', 'agent session not found')
      }
      return respond(existing, false)
    }
    const body = request.body as CreateBody
    const session = await createAgentSession(deps.db, {
      organizationId,
      actorUserId: authz.userId,
      provider: body.provider,
      hostId: body.hostId,
      ...(body.providerSessionId ? { providerSessionId: body.providerSessionId } : {}),
      ...(body.launchId ? { launchId: body.launchId } : {}),
      ...(body.workItemId ? { workItemId: body.workItemId } : {}),
      ...(body.visibility ? { visibility: body.visibility } : {}),
      ...(body.classification ? { classification: body.classification } : {}),
      ...(body.captureMode ? { captureMode: body.captureMode } : {})
    })
    await gate.complete(session.id)
    return respond(session, true)
  })
}

async function getExistingSession(
  deps: AgentSessionRoutesDeps,
  organizationId: string,
  sessionId: string
): Promise<AgentSession | null> {
  const timeline = await listSessionTimeline(deps.db, organizationId, sessionId, { limit: 1 })
  return timeline ? timeline.session : null
}

function registerBatchIngest(app: FastifyInstance, deps: AgentSessionRoutesDeps): void {
  // Org-level batch ingest at `.../agent-events:batch`. agent_event.ingest gate; Idempotency-Key
  // required at the batch level. A batch whose events claim another org is rejected outright
  // (anti-forgery); per-event session/producer failures reject only that item.
  app.post('/v1/organizations/:organizationId/:ingestTarget', async (request, reply) => {
    const { organizationId, ingestTarget } = request.params as {
      organizationId: string
      ingestTarget: string
    }
    if (ingestTarget !== AGENT_EVENTS_BATCH_TOKEN) {
      return problem(reply, request, 404, 'NOT_FOUND', 'unknown organization action')
    }
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    if (!UUID_PATTERN.test(organizationId)) {
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    }
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'agent_event.ingest'
    )
    if (!authz) {
      return reply
    }
    if (!validates(deps.registry, AGENT_EVENT_BATCH_REQUEST_SCHEMA_ID, request.body)) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid agent event batch')
    }
    const body = request.body as BatchBody
    // Anti-forgery: a batch cannot smuggle events for another org than the path org.
    if (body.events.some((event) => event.pieorgid !== organizationId)) {
      return problem(reply, request, 400, 'ORG_MISMATCH', 'batch event targets a different org')
    }
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      {
        organizationId,
        principalId: principal.subject,
        method: 'POST',
        route: AGENT_EVENTS_BATCH_ROUTE
      },
      request.body
    )
    if (!gate) {
      return reply
    }
    const input: IngestAgentEventsInput = {
      organizationId,
      batchId: body.batchId,
      producerId: body.producerId,
      // The authenticated principal is the audit actor for any projected provenance.
      actorId: principal.subject,
      // R5 s2b: the pie user id owns the installation key a signed context is verified against.
      ...(authz.userId ? { actorUserId: authz.userId } : {}),
      ...(body.executionContext ? { executionContext: body.executionContext } : {}),
      ...(body.submissionNonce ? { submissionNonce: body.submissionNonce } : {}),
      receivedAt: new Date(),
      clientCheckpoint: body.clientCheckpoint,
      events: body.events
    }
    // Ingest is idempotent per (org, eventId), so re-running on an Idempotency-Key replay is safe
    // (every event returns `duplicate`); the batch key only guards key-reuse / concurrent replays.
    const result = await ingestAgentEvents(deps.db, input)
    if (result.contextRejection) {
      // The signed context was refused: no events ingested. Release the idempotency key (not
      // complete) so a corrected retry with the same key can re-run rather than replay the refusal.
      await gate.release()
      return problem(
        reply,
        request,
        422,
        result.contextRejection.code,
        'signed execution context rejected'
      )
    }
    await gate.complete(body.batchId)
    assertResponse(deps.registry, AGENT_EVENT_BATCH_RESPONSE_SCHEMA_ID, result)
    void reply.code(200)
    return result
  })
}

function registerTimeline(app: FastifyInstance, deps: AgentSessionRoutesDeps): void {
  // The session's projected turn/event timeline, cursor-paged. agent_session.read org gate.
  app.get(
    '/v1/organizations/:organizationId/agent-sessions/:sessionId/timeline',
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
      const query = request.query as { cursor?: string; limit?: string; scope?: string }
      const limit = query.limit ? Number(query.limit) : undefined
      // The read never returns content above the caller's authorized scope.
      const scope = await resolveReadScope(deps.db, principal, organizationId, query.scope)
      const timeline = await listSessionTimeline(deps.db, organizationId, sessionId, {
        scope,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {})
      })
      if (!timeline) {
        return problem(reply, request, 404, 'NOT_FOUND', 'agent session not found')
      }
      const wire = {
        session: sessionToWire(timeline.session),
        turns: timeline.turns,
        events: timeline.events,
        captureGaps: timeline.captureGaps,
        nextCursor: timeline.nextCursor
      }
      assertResponse(deps.registry, AGENT_SESSION_TIMELINE_SCHEMA_ID, wire)
      return wire
    }
  )
}

function registerProvenance(app: FastifyInstance, deps: AgentSessionRoutesDeps): void {
  // The session's provenance evidence (commits, PRs/MRs, test/build, artifacts, file changes)
  // with its trust domain, cursor-paged. agent_session.read gate — declared claims are returned
  // flagged verifiedEvidence=false so a caller never mistakes a claim for a verified result.
  app.get(
    '/v1/organizations/:organizationId/agent-sessions/:sessionId/provenance',
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
      const query = request.query as { cursor?: string; limit?: string; scope?: string }
      const limit = query.limit ? Number(query.limit) : undefined
      // Provenance above the caller's authorized scope is absent (filtered by source visibility).
      const scope = await resolveReadScope(deps.db, principal, organizationId, query.scope)
      const provenance = await listSessionProvenance(deps.db, organizationId, sessionId, {
        scope,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {})
      })
      if (!provenance) {
        return problem(reply, request, 404, 'NOT_FOUND', 'agent session not found')
      }
      const wire = {
        session: sessionToWire(provenance.session),
        items: provenance.items,
        nextCursor: provenance.nextCursor
      }
      assertResponse(deps.registry, AGENT_SESSION_PROVENANCE_SCHEMA_ID, wire)
      return wire
    }
  )
}

export function registerAgentSessionRoutes(
  app: FastifyInstance,
  deps: AgentSessionRoutesDeps
): void {
  registerCreateSession(app, deps)
  registerTimeline(app, deps)
  registerProvenance(app, deps)
  registerBatchIngest(app, deps)
}
