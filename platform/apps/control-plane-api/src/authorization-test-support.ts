import type { KeycloakTokenVerifier, VerifiedPrincipal } from './keycloak-token-verifier'
import type { ConnectionAuthorization } from './realtime-gateway'

export const TEST_ISSUER = 'https://test-issuer.local/realms/pie'

/**
 * A token verifier for tests that DON'T exercise token cryptography (that is
 * proven with real Keycloak + the node:crypto verifier tests). The bearer string
 * IS the subject, so a test can mint a "token" for any seeded membership. It
 * exercises the REAL RBAC/membership path while faking only the crypto layer.
 */
export function createTestTokenVerifier(): KeycloakTokenVerifier {
  return {
    verify: async (token: string): Promise<VerifiedPrincipal> => {
      if (!token) {
        throw new Error('empty token')
      }
      return {
        issuer: TEST_ISSUER,
        subject: token,
        email: `${token}@test`,
        emailVerified: true,
        displayName: 'Test Subject',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString()
      }
    }
  }
}

/** A permissive gateway authorizer for verticals that test delivery/isolation, not
 *  auth. Real WS auth is covered in the dedicated RBAC realtime test. */
export function allowAllConnections(): (
  token: string | null,
  organizationId: string
) => Promise<ConnectionAuthorization> {
  return async () => ({ authorized: true })
}
