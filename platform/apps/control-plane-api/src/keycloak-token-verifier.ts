import { createRemoteJWKSet, jwtVerify } from 'jose'

// A token principal after signature/issuer/audience/expiry verification. This is
// authenticated identity ONLY — Pie authorization (Membership/permissions) is
// judged separately (ADR-0009 clause 8), never from the token's claims.
export type VerifiedPrincipal = {
  issuer: string
  subject: string
  email: string
  emailVerified: boolean
  displayName: string
  expiresAt: string
  // The Keycloak session id (`sid` claim), keying the Pie session record used for
  // revocation enforcement. Empty string when the token carries no sid.
  sessionId: string
}

export type TokenVerifierConfig = {
  // Pinned from config — the token can NEVER select its own issuer (ADR-0009 §8).
  issuer: string
  audience: string
  jwksUri: string
}

export type KeycloakTokenVerifier = {
  verify: (token: string) => Promise<VerifiedPrincipal>
}

/** Keycloak's JWKS endpoint for a realm issuer, unless overridden in config. */
export function defaultJwksUri(issuer: string): string {
  return `${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`
}

/**
 * Verifies Keycloak-issued access tokens against the realm's JWKS: signature,
 * issuer, audience, and expiry (jose enforces exp/nbf). The issuer and audience
 * are pinned from config, so a token cannot assert a different issuer to be
 * trusted. The JWKS is fetched from the issuer and cached by jose.
 */
export function createKeycloakTokenVerifier(config: TokenVerifierConfig): KeycloakTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUri))
  return {
    verify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience
      })
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new Error('token has no subject')
      }
      const email = typeof payload.email === 'string' ? payload.email : ''
      const preferredUsername =
        typeof payload.preferred_username === 'string' ? payload.preferred_username : ''
      const name = typeof payload.name === 'string' ? payload.name : ''
      return {
        issuer: config.issuer,
        subject: payload.sub,
        email,
        emailVerified: payload.email_verified === true,
        displayName: name || preferredUsername || email || payload.sub,
        expiresAt: new Date((payload.exp ?? 0) * 1000).toISOString(),
        sessionId: typeof payload.sid === 'string' ? payload.sid : ''
      }
    }
  }
}
