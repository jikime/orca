import {
  authorizeSubjectForOrg,
  recordAuthorizationDenial,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { VerifiedPrincipal } from './keycloak-token-verifier'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'

/**
 * Shared org-scoped RBAC gate for REST routes (doc 01:215-231): resolves the
 * caller's membership in the org, checks the required permission, and on deny
 * records a reason-coded audit event and sends 403. Returns true only when the
 * caller may proceed.
 */
export async function authorizeOrgPermission(
  db: PieDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  principal: VerifiedPrincipal,
  organizationId: string,
  permission: string
): Promise<boolean> {
  const { decision, userId } = await authorizeSubjectForOrg(
    db,
    { issuer: principal.issuer, subject: principal.subject },
    organizationId,
    permission
  )
  if (decision.allowed) {
    return true
  }
  await recordAuthorizationDenial(db, decision, {
    requestedOrganizationId: organizationId,
    userId,
    issuer: principal.issuer,
    subject: principal.subject,
    requiredPermission: permission,
    requestId: requestCorrelationId(request)
  })
  sendProblem(
    reply,
    buildProblemDetails({
      status: 403,
      title: `authorization denied: ${decision.reason}`,
      code: 'FORBIDDEN',
      requestId: requestCorrelationId(request),
      instance: request.url
    })
  )
  return false
}
