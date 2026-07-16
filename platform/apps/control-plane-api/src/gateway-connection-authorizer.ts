import { authorizeSubjectForOrg, type PieDatabase } from '@pie/persistence'
import type { KeycloakTokenVerifier } from './keycloak-token-verifier'
import type { ConnectionAuthorization } from './realtime-gateway'

/**
 * The production Realtime connection authorizer: verifies the bearer token, then
 * confirms the subject holds organization.read in the requested org. A missing or
 * invalid token, or a subject with no active membership in that org, is rejected —
 * the org from ClientHello is never trusted on its own.
 */
export function createGatewayConnectionAuthorizer(
  db: PieDatabase,
  verifier: KeycloakTokenVerifier
): (token: string | null, organizationId: string) => Promise<ConnectionAuthorization> {
  return async (token, organizationId) => {
    if (!token) {
      return { authorized: false, reason: 'unauthenticated' }
    }
    let principal
    try {
      principal = await verifier.verify(token)
    } catch {
      return { authorized: false, reason: 'invalid_token' }
    }
    const { decision, userId } = await authorizeSubjectForOrg(
      db,
      { issuer: principal.issuer, subject: principal.subject },
      organizationId,
      'organization.read'
    )
    return {
      authorized: decision.allowed,
      reason: decision.allowed ? undefined : decision.reason,
      ...(userId ? { userId } : {})
    }
  }
}
