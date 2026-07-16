import {
  authorizeSubjectForOrg,
  authorizeSubjectForResource,
  recordAuthorizationDenial,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { VerifiedPrincipal } from './keycloak-token-verifier'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'

/**
 * Shared org-scoped RBAC gate for REST routes (doc 01:215-231): resolves the
 * caller's membership in the org, checks the required permission, and on deny
 * records a reason-coded audit event and sends 403. Returns the caller's Pie user
 * id when allowed, or null when denied (403 already sent).
 */
export async function authorizeOrgPermission(
  db: PieDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  principal: VerifiedPrincipal,
  organizationId: string,
  permission: string
): Promise<{ userId: string | null } | null> {
  const { decision, userId } = await authorizeSubjectForOrg(
    db,
    { issuer: principal.issuer, subject: principal.subject },
    organizationId,
    permission
  )
  if (decision.allowed) {
    return { userId }
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
  return null
}

/**
 * Resource-scoped RBAC gate — the sibling of authorizeOrgPermission that threads a
 * specific resource through the evaluator's narrow/widen step (doc 01:165-181).
 * Org-level routes keep using authorizeOrgPermission unchanged.
 */
export async function authorizeResourcePermission(
  db: PieDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  principal: VerifiedPrincipal,
  organizationId: string,
  resource: { resourceType: string; resourceId: string },
  permission: string
): Promise<{ userId: string | null } | null> {
  const { decision, userId } = await authorizeSubjectForResource(
    db,
    { issuer: principal.issuer, subject: principal.subject },
    organizationId,
    resource,
    permission
  )
  if (decision.allowed) {
    return { userId }
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
  return null
}
