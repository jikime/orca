import {
  createRemoteSession,
  getRemoteSession,
  grantConsent,
  joinParticipant,
  leaveParticipant,
  listRemoteSessions,
  revokeConsent,
  transitionRemoteSession,
  updateParticipantGrade,
  type ParticipantGrade,
  type PieDatabase,
  type RemoteSessionDetail,
  type RemoteSessionKind,
  type RemoteSessionStatus
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission, authorizeResourcePermission } from './route-authorization'

const REMOTE_SESSION_SCHEMA_ID = 'https://schemas.pielab.ai/resources/remote-session.v1.schema.json'
const REMOTE_SESSION_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/remote-session-create.v1.schema.json'
const REMOTE_SESSION_TRANSITION_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/remote-session-transition.v1.schema.json'
const PARTICIPANT_ADD_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/remote-session-participant-add.v1.schema.json'
const PARTICIPANT_GRADE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/remote-session-participant-grade.v1.schema.json'
const CONSENT_GRANT_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/remote-session-consent-grant.v1.schema.json'
const REMOTE_SESSIONS_ROUTE = '/v1/organizations/{organizationId}/remote-sessions'
const PARTICIPANTS_ROUTE =
  '/v1/organizations/{organizationId}/remote-sessions/{sessionId}/participants'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REMOTE_SESSION_RESOURCE_TYPE = 'remote_session'

// The session ETag / If-Match carrier for transition OCC — same shape as the work-item PATCH.
function sessionEtag(version: number): string {
  return `"remote-session-${version}"`
}

function ifMatchSessionVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"remote-session-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export type RemoteSessionRoutesDeps = {
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

// Detail → wire shape. participants/latestConsent are optional in the schema, so both the
// list (bare session) and the single GET (with roster + consent) validate against one schema.
function toWire(session: RemoteSessionDetail): Record<string, unknown> {
  return {
    id: session.id,
    organizationId: session.organizationId,
    kind: session.kind,
    status: session.status,
    hostUserId: session.hostUserId,
    createdBy: session.createdBy,
    ticketId: session.ticketId,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    participants: session.participants.map((p) => ({
      id: p.id,
      userId: p.userId,
      grade: p.grade,
      isDriver: p.isDriver,
      joinedAt: p.joinedAt,
      leftAt: p.leftAt
    })),
    latestConsent: session.latestConsent
      ? {
          id: session.latestConsent.id,
          subjectUserId: session.latestConsent.subjectUserId,
          scope: session.latestConsent.scope,
          grantedAt: session.latestConsent.grantedAt,
          revokedAt: session.latestConsent.revokedAt
        }
      : null
  }
}

function toSummaryWire(session: {
  id: string
  organizationId: string
  kind: string
  status: string
  hostUserId: string
  createdBy: string
  ticketId: string | null
  version: number
  createdAt: string
  updatedAt: string
}): Record<string, unknown> {
  return {
    id: session.id,
    organizationId: session.organizationId,
    kind: session.kind,
    status: session.status,
    hostUserId: session.hostUserId,
    createdBy: session.createdBy,
    ticketId: session.ticketId,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }
}

export function registerRemoteSessionRoutes(
  app: FastifyInstance,
  deps: RemoteSessionRoutesDeps
): void {
  // Create a session (doc 34 A1). remote.view org gate to open one; the creator becomes an
  // admin participant in the store. Idempotency-Key required; 201 + Location.
  app.post('/v1/organizations/:organizationId/remote-sessions', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'remote.view'
    )
    if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
    if (!validates(deps.registry, REMOTE_SESSION_CREATE_SCHEMA_ID, request.body))
      return problem(
        reply,
        request,
        400,
        'VALIDATION_FAILED',
        'invalid remote session create request'
      )
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      {
        organizationId,
        principalId: principal.subject,
        method: 'POST',
        route: REMOTE_SESSIONS_ROUTE
      },
      request.body
    )
    if (!gate) return reply
    const respond = async (sessionId: string, created: boolean): Promise<unknown> => {
      const detail = await getRemoteSession(deps.db, organizationId, sessionId)
      if (!detail) return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
      const wire = toWire(detail)
      assertResponse(deps.registry, REMOTE_SESSION_SCHEMA_ID, wire)
      void reply
        .code(created ? 201 : 200)
        .header('location', `/v1/organizations/${organizationId}/remote-sessions/${sessionId}`)
        .header('etag', sessionEtag(detail.version))
      return wire
    }
    if (gate.priorResourceId) {
      return respond(gate.priorResourceId, false)
    }
    const body = request.body as { kind: RemoteSessionKind; hostUserId: string; ticketId?: string }
    const session = await createRemoteSession(deps.db, {
      organizationId,
      actorUserId: authz.userId,
      kind: body.kind,
      hostUserId: body.hostUserId,
      ...(body.ticketId ? { ticketId: body.ticketId } : {})
    })
    await gate.complete(session.id)
    return respond(session.id, true)
  })

  // List an org's sessions (remote.view org gate — a member-visible index over sessions).
  app.get('/v1/organizations/:organizationId/remote-sessions', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'remote.view'
    )
    if (!authz) return reply
    const items = await listRemoteSessions(deps.db, organizationId)
    const wire = items.map(toSummaryWire)
    for (const item of wire) assertResponse(deps.registry, REMOTE_SESSION_SCHEMA_ID, item)
    return { items: wire, nextCursor: null }
  })

  // Read one session (resource-gated remote.view on THIS session — a widen grant lets a
  // non-org-viewer read a specific session they were added to).
  app.get(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, sessionId } = request.params as {
        organizationId: string
        sessionId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(sessionId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeResourcePermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
        'remote.view'
      )
      if (!authz) return reply
      const detail = await getRemoteSession(deps.db, organizationId, sessionId)
      if (!detail) return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
      const wire = toWire(detail)
      assertResponse(deps.registry, REMOTE_SESSION_SCHEMA_ID, wire)
      void reply.header('etag', sessionEtag(detail.version))
      return wire
    }
  )

  // Transition a session (doc 07 state machine). resource gate remote.control; If-Match OCC.
  // illegal jump → 409, stale version → 409, missing consent for 연결중 → 422, missing If-Match
  // → 428, non-admin/host → 403.
  // find-my-way cannot parse a param immediately followed by a literal ':' suffix, so the
  // whole `{sessionId}:transition` token is one param split here (mirrors work-item :move-state).
  // The client-facing URL is still `.../remote-sessions/{sessionId}:transition`.
  app.post(
    '/v1/organizations/:organizationId/remote-sessions/:sessionTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, sessionTarget } = request.params as {
        organizationId: string
        sessionTarget: string
      }
      const colon = sessionTarget.lastIndexOf(':')
      const sessionId = colon === -1 ? sessionTarget : sessionTarget.slice(0, colon)
      const action = colon === -1 ? '' : sessionTarget.slice(colon + 1)
      if (action !== 'transition')
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown remote session action')
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(sessionId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeResourcePermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
        'remote.control'
      )
      if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
      const expectedVersion = ifMatchSessionVersion(request)
      if (expectedVersion === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      if (!validates(deps.registry, REMOTE_SESSION_TRANSITION_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transition request')
      const body = request.body as { toStatus: RemoteSessionStatus }
      const result = await transitionRemoteSession(deps.db, {
        organizationId,
        sessionId,
        actorUserId: authz.userId,
        toStatus: body.toStatus,
        expectedVersion
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
        if (result.reason === 'forbidden')
          return problem(
            reply,
            request,
            403,
            'FORBIDDEN',
            'only the host or an admin may transition'
          )
        if (result.reason === 'version_conflict')
          return problem(
            reply,
            request,
            409,
            'VERSION_CONFLICT',
            'session was modified concurrently'
          )
        if (result.reason === 'consent_required')
          return problem(
            reply,
            request,
            422,
            'CONSENT_REQUIRED',
            'an active consent is required to connect'
          )
        return problem(
          reply,
          request,
          409,
          'ILLEGAL_TRANSITION',
          `cannot transition from ${result.from} to ${body.toStatus}`
        )
      }
      const detail = await getRemoteSession(deps.db, organizationId, sessionId)
      if (!detail) return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
      const wire = toWire(detail)
      assertResponse(deps.registry, REMOTE_SESSION_SCHEMA_ID, wire)
      void reply.header('etag', sessionEtag(detail.version))
      return wire
    }
  )

  // Add a participant (doc 07 roster). resource gate remote.control; the store enforces
  // host/admin authority. 201 + Location to the participant.
  app.post(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/participants',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, sessionId } = request.params as {
        organizationId: string
        sessionId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(sessionId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeResourcePermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
        'remote.control'
      )
      if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
      if (!validates(deps.registry, PARTICIPANT_ADD_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid participant add request')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: principal.subject,
          method: 'POST',
          route: PARTICIPANTS_ROUTE
        },
        request.body
      )
      if (!gate) return reply
      const body = request.body as { userId: string; grade: ParticipantGrade }
      const result = await joinParticipant(deps.db, {
        organizationId,
        sessionId,
        actorUserId: authz.userId,
        userId: body.userId,
        grade: body.grade
      })
      if (!result.ok) {
        await gate.release()
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
        if (result.reason === 'forbidden')
          return problem(
            reply,
            request,
            403,
            'FORBIDDEN',
            'only the host or an admin may add participants'
          )
        if (result.reason === 'terminal')
          return problem(
            reply,
            request,
            409,
            'SESSION_TERMINAL',
            'a terminal session accepts no participants'
          )
        return problem(
          reply,
          request,
          409,
          'ALREADY_JOINED',
          'user is already an active participant'
        )
      }
      await gate.complete(result.participant.id)
      void reply
        .code(201)
        .header(
          'location',
          `/v1/organizations/${organizationId}/remote-sessions/${sessionId}/participants/${result.participant.id}`
        )
      return {
        id: result.participant.id,
        userId: result.participant.userId,
        grade: result.participant.grade,
        isDriver: result.participant.isDriver,
        joinedAt: result.participant.joinedAt,
        leftAt: result.participant.leftAt
      }
    }
  )

  // Change a participant's grade (doc 07: 권한은 세션 중에도 회수). resource gate remote.control;
  // the store enforces host/admin authority. If-Match is declared in the contract for symmetry
  // but a roster row carries no version, so it is not enforced here.
  app.patch(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/participants/:participantId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, sessionId, participantId } = request.params as {
        organizationId: string
        sessionId: string
        participantId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(sessionId) ||
        !UUID_PATTERN.test(participantId)
      )
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeResourcePermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
        'remote.control'
      )
      if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
      if (!validates(deps.registry, PARTICIPANT_GRADE_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid grade change request')
      const body = request.body as { grade: ParticipantGrade }
      const result = await updateParticipantGrade(deps.db, {
        organizationId,
        sessionId,
        actorUserId: authz.userId,
        participantId,
        grade: body.grade
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
        if (result.reason === 'forbidden')
          return problem(
            reply,
            request,
            403,
            'FORBIDDEN',
            'only the host or an admin may change grades'
          )
        return problem(reply, request, 404, 'NOT_FOUND', 'participant not found')
      }
      return {
        id: result.participant.id,
        userId: result.participant.userId,
        grade: result.participant.grade,
        isDriver: result.participant.isDriver,
        joinedAt: result.participant.joinedAt,
        leftAt: result.participant.leftAt
      }
    }
  )

  // Remove a participant (leave). resource gate remote.control; the store allows self-leave or
  // host/admin removal. 204 idempotent-shaped.
  app.delete(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/participants/:participantId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, sessionId, participantId } = request.params as {
        organizationId: string
        sessionId: string
        participantId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(sessionId) ||
        !UUID_PATTERN.test(participantId)
      )
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeResourcePermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
        'remote.control'
      )
      if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
      const result = await leaveParticipant(deps.db, {
        organizationId,
        sessionId,
        actorUserId: authz.userId,
        participantId
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
        if (result.reason === 'forbidden')
          return problem(
            reply,
            request,
            403,
            'FORBIDDEN',
            'only the host, an admin, or the participant may leave'
          )
        return problem(reply, request, 404, 'NOT_FOUND', 'participant not found')
      }
      void reply.code(204).send()
      return reply
    }
  )

  // Grant consent (doc 07 고객 동의). The SUBJECT acts on themselves — subjectUserId is the
  // authenticated user, never a supplied id (no consent-by-proxy). resource gate remote.view.
  app.post(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/consent',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, sessionId } = request.params as {
        organizationId: string
        sessionId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(sessionId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeResourcePermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
        'remote.view'
      )
      if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
      if (
        request.body !== undefined &&
        !validates(deps.registry, CONSENT_GRANT_SCHEMA_ID, request.body)
      )
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid consent grant request')
      const body = (request.body ?? {}) as { scope?: string }
      const result = await grantConsent(deps.db, {
        organizationId,
        sessionId,
        subjectUserId: authz.userId,
        ...(body.scope ? { scope: body.scope } : {})
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
        return problem(
          reply,
          request,
          409,
          'SESSION_TERMINAL',
          'a terminal session accepts no consent'
        )
      }
      void reply.code(200)
      return {
        id: result.consent.id,
        subjectUserId: result.consent.subjectUserId,
        scope: result.consent.scope,
        grantedAt: result.consent.grantedAt,
        revokedAt: result.consent.revokedAt
      }
    }
  )

  // Revoke consent (doc 07: 동의 철회 → 입력 즉시 차단, 연결 종료). The subject withdraws their own
  // consent; the store records it and forces the session to `ended`. 204.
  app.delete(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/consent',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, sessionId } = request.params as {
        organizationId: string
        sessionId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(sessionId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeResourcePermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
        'remote.view'
      )
      if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
      const result = await revokeConsent(deps.db, {
        organizationId,
        sessionId,
        subjectUserId: authz.userId
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
        return problem(reply, request, 409, 'NO_ACTIVE_CONSENT', 'no active consent to revoke')
      }
      void reply.code(204).send()
      return reply
    }
  )
}
