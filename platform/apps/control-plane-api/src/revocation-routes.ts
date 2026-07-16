import {
  getUserIdForSubject,
  revokeMembership,
  revokeSession,
  revokeUserSessions,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import type { RealtimeGateway } from './realtime-gateway'
import { authorizeOrgPermission } from './route-authorization'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RevocationRoutesDeps = { db: PieDatabase; gateway: RealtimeGateway }

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

/**
 * Revocation routes (doc 01:150-163). CONTRACT GAP: no OpenAPI operations —
 * to-be-contracted internal routes, flagged (wire contract not extended).
 */
export function registerRevocationRoutes(app: FastifyInstance, deps: RevocationRoutesDeps): void {
  // Admin revokes a member: their org authorization drops on the next request
  // (RBAC status check) and any live realtime connection is told immediately.
  app.post(
    '/v1/organizations/:organizationId/memberships/:userId/revoke',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) {
        return reply
      }
      const { organizationId, userId } = request.params as {
        organizationId: string
        userId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(userId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      }
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'member.manage'
      )
      if (!authz) {
        return reply
      }
      const result = await revokeMembership(deps.db, {
        organizationId,
        targetUserId: userId,
        actorUserId: authz.userId ?? organizationId
      })
      if (result.outcome === 'not_a_member') {
        return problem(reply, request, 404, 'NOT_FOUND', 'not an active member')
      }
      if (result.outcome === 'last_owner_blocked') {
        return problem(
          reply,
          request,
          409,
          'LAST_OWNER',
          'the last organization owner cannot be removed; transfer ownership first'
        )
      }
      // Tell the revoked member's live connections immediately (membership_revoked).
      deps.gateway.notifySessionRevoked(userId, 'membership_revoked')
      return { outcome: 'revoked' }
    }
  )

  // Self-service session revocation (doc 01:157): revoke the current session, all
  // sessions, or all-but-current. Uses the caller's own verified session.
  app.post('/v1/sessions/revoke', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    const body = (request.body ?? {}) as { scope?: 'current' | 'all' | 'others' }
    const scope = body.scope ?? 'current'
    if (scope === 'current') {
      if (principal.sessionId) {
        await revokeSession(deps.db, { sessionId: principal.sessionId, reason: 'user_logout' })
      }
      return { outcome: 'revoked', scope }
    }
    const userId = await getUserIdForSubject(deps.db, principal.issuer, principal.subject)
    if (!userId) {
      return { outcome: 'revoked', scope }
    }
    await revokeUserSessions(deps.db, {
      userId,
      reason: 'user_logout',
      ...(scope === 'others' && principal.sessionId ? { exceptSessionId: principal.sessionId } : {})
    })
    deps.gateway.notifySessionRevoked(userId, 'user_logout')
    return { outcome: 'revoked', scope }
  })
}
