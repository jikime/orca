import { defaultJwksUri, type TokenVerifierConfig } from './keycloak-token-verifier'

/**
 * Token-verification config. The issuer is PINNED here (never taken from the
 * token). Audience defaults to the desktop client id — the realm's audience
 * mapper puts `pie-desktop` in the access token's aud. JWKS defaults to the
 * realm's certs endpoint. All overridable per deployment.
 */
export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  fallbackIssuer = 'http://127.0.0.1:8080/realms/pie'
): TokenVerifierConfig {
  const issuer = env.PIE_KEYCLOAK_ISSUER ?? env.PIE_DISCOVERY_ISSUER ?? fallbackIssuer
  return {
    issuer,
    audience: env.PIE_KEYCLOAK_AUDIENCE ?? env.PIE_DISCOVERY_CLIENT_ID ?? 'pie-desktop',
    jwksUri: env.PIE_KEYCLOAK_JWKS_URI ?? defaultJwksUri(issuer)
  }
}
