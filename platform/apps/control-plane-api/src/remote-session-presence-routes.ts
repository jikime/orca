import {
  fireEphemeralNotification,
  getRemoteSession,
  type PieDatabase,
  type RemoteSessionDetail,
  type RemoteSessionParticipant
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeResourcePermission } from './route-authorization'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REMOTE_SESSION_RESOURCE_TYPE = 'remote_session'

// A terminal session (ended/reviewed) has no live participants — so a departed
// participant can't keep appearing, further presence/cursor posts are rejected here.
const TERMINAL_STATUSES = new Set(['ended', 'reviewed'])

// Per-(participant, session) coalesce windows. Presence mirrors chat typing (1/sec);
// cursor is capped tighter so a busy cursor can never flood the ephemeral NOTIFY path
// (data-over-presence — a dropped ping self-heals, the payload IS the full state).
const PRESENCE_COALESCE_MS = 1000
const CURSOR_COALESCE_MS = 100

export type RemoteSessionPresenceRoutesDeps = {
  db: PieDatabase
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

function activeParticipant(
  detail: RemoteSessionDetail,
  userId: string
): RemoteSessionParticipant | null {
  return detail.participants.find((p) => p.userId === userId && p.leftAt === null) ?? null
}

export function registerRemoteSessionPresenceRoutes(
  app: FastifyInstance,
  deps: RemoteSessionPresenceRoutesDeps
): void {
  // In-memory per-(participant,session) rate cap, scoped to this API node. Best-effort:
  // the point is to cap the NOTIFY rate, not to be exact across horizontally-scaled nodes.
  const presenceLastFired = new Map<string, number>()
  const cursorLastFired = new Map<string, number>()

  // Shared gate: authenticate, resource-scoped remote.view, active-participant membership,
  // and non-terminal session. Returns the caller's active participant on success, else
  // sends the problem response and returns null.
  const gateParticipant = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<{
    participant: RemoteSessionParticipant
    organizationId: string
    sessionId: string
  } | null> => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return null
    }
    const { organizationId, sessionId } = request.params as {
      organizationId: string
      sessionId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(sessionId)) {
      problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      return null
    }
    const authz = await authorizeResourcePermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
      'remote.view'
    )
    if (!authz) {
      return null
    }
    if (!authz.userId) {
      reply.code(403).send()
      return null
    }
    const detail = await getRemoteSession(deps.db, organizationId, sessionId)
    if (!detail) {
      problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
      return null
    }
    // Terminal session — reject so a departed participant can't keep appearing.
    if (TERMINAL_STATUSES.has(detail.status)) {
      problem(reply, request, 409, 'SESSION_TERMINAL', 'session has ended')
      return null
    }
    // Participant gate: only an ACTIVE participant may emit presence/cursor for the session.
    const participant = activeParticipant(detail, authz.userId)
    if (!participant) {
      problem(reply, request, 403, 'FORBIDDEN', 'not a participant of this session')
      return null
    }
    return { participant, organizationId, sessionId }
  }

  // Presence: ephemeral fire-and-forget for a session participant. Writes NO row, NEVER
  // touches the outbox — a bare pg_notify the gateway relays to the session's participants.
  app.post(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/presence',
    async (request, reply) => {
      const gated = await gateParticipant(request, reply)
      if (!gated) {
        return reply
      }
      const { participant, organizationId, sessionId } = gated
      const body = (request.body ?? {}) as { state?: unknown }
      const state = body.state === 'offline' ? 'offline' : 'online'
      const rateKey = `${participant.id}:${sessionId}`
      const nowMs = Date.now()
      const last = presenceLastFired.get(rateKey) ?? 0
      if (nowMs - last >= PRESENCE_COALESCE_MS) {
        presenceLastFired.set(rateKey, nowMs)
        await fireEphemeralNotification(deps.db, {
          kind: 'remote_presence',
          organizationId,
          sessionId,
          participantId: participant.id,
          userId: participant.userId,
          state,
          role: participant.grade,
          at: new Date(nowMs).toISOString()
        })
      }
      void reply.code(204).send()
      return reply
    }
  )

  // Cursor: ephemeral fire-and-forget row/col for a session participant. Same lossy,
  // no-durable contract as presence; row/col must be finite and non-negative.
  app.post(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/cursor',
    async (request, reply) => {
      const gated = await gateParticipant(request, reply)
      if (!gated) {
        return reply
      }
      const { participant, organizationId, sessionId } = gated
      const body = (request.body ?? {}) as { row?: unknown; col?: unknown }
      if (
        typeof body.row !== 'number' ||
        !Number.isFinite(body.row) ||
        body.row < 0 ||
        typeof body.col !== 'number' ||
        !Number.isFinite(body.col) ||
        body.col < 0
      ) {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'row/col must be finite and >= 0')
      }
      const rateKey = `${participant.id}:${sessionId}`
      const nowMs = Date.now()
      const last = cursorLastFired.get(rateKey) ?? 0
      if (nowMs - last >= CURSOR_COALESCE_MS) {
        cursorLastFired.set(rateKey, nowMs)
        await fireEphemeralNotification(deps.db, {
          kind: 'remote_cursor',
          organizationId,
          sessionId,
          participantId: participant.id,
          row: body.row,
          col: body.col,
          at: new Date(nowMs).toISOString()
        })
      }
      void reply.code(204).send()
      return reply
    }
  )
}
