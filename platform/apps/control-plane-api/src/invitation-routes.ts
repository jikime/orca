import {
  acceptInvitation,
  createInvitation,
  InvalidInviteRoleError,
  revokeInvitation,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type InvitationRoutesDeps = { db: PieDatabase }

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

const ACCEPT_REJECTION: Record<string, { status: number; code: string }> = {
  invalid_token: { status: 404, code: 'INVITE_INVALID' },
  expired: { status: 410, code: 'INVITE_EXPIRED' },
  not_pending: { status: 409, code: 'INVITE_ALREADY_USED' },
  email_mismatch: { status: 403, code: 'INVITE_EMAIL_MISMATCH' },
  email_unverified: { status: 403, code: 'EMAIL_NOT_VERIFIED' }
}

/**
 * Invitation routes (doc 01:81-94). CONTRACT GAP: the OpenAPI has no invitation
 * operations — these are to-be-contracted internal routes, flagged for the next
 * contracts slice (the wire contract is NOT extended here).
 */
export function registerInvitationRoutes(app: FastifyInstance, deps: InvitationRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/invitations', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId)) {
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    }
    // Creating invites is member.invite (owner/admin only in the manifest).
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'member.invite'
    )
    if (!authz) {
      return reply
    }
    const body = (request.body ?? {}) as { email?: string; userType?: string; roleIds?: string[] }
    if (!body.email || !body.userType || !Array.isArray(body.roleIds)) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'email, userType, roleIds required')
    }
    try {
      const result = await createInvitation(deps.db, {
        organizationId,
        actorUserId: authz.userId ?? organizationId,
        email: body.email,
        userType: body.userType,
        roleIds: body.roleIds
      })
      // The raw token is returned ONCE (delivered by email in reality; the R2 email
      // seam would log it — nothing is actually sent).
      void reply.code(201)
      return result
    } catch (error) {
      if (error instanceof InvalidInviteRoleError) {
        return problem(reply, request, 400, 'INVALID_ROLE', error.message)
      }
      throw error
    }
  })

  app.post(
    '/v1/organizations/:organizationId/invitations/:invitationId/revoke',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) {
        return reply
      }
      const { organizationId, invitationId } = request.params as {
        organizationId: string
        invitationId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(invitationId)) {
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
      const result = await revokeInvitation(deps.db, {
        organizationId,
        invitationId,
        actorUserId: authz.userId ?? organizationId
      })
      if (result.outcome === 'not_pending') {
        return problem(reply, request, 409, 'INVITE_NOT_PENDING', 'invitation is not pending')
      }
      return { outcome: result.outcome }
    }
  )

  app.post('/v1/invitations/accept', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    const body = (request.body ?? {}) as { token?: string }
    if (!body.token) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'token required')
    }
    const result = await acceptInvitation(
      deps.db,
      {
        issuer: principal.issuer,
        subject: principal.subject,
        email: principal.email,
        emailVerified: principal.emailVerified,
        displayName: principal.displayName
      },
      body.token
    )
    if (!result.ok) {
      const mapped = ACCEPT_REJECTION[result.reason] ?? { status: 403, code: 'INVITE_INVALID' }
      return problem(reply, request, mapped.status, mapped.code, `invitation ${result.reason}`)
    }
    return { organizationId: result.organizationId, membershipId: result.membershipId }
  })
}
