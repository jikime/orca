export type PieAuthConfig = {
  enabled: boolean
  // The Pie instance discovery endpoint (returns the auth issuer/clientId). The
  // login flow fetches + validates it before any browser is opened.
  discoveryUrl: string | null
  // Stable per-install id used for the session scope + realm mapping.
  profileId: string
  // Dev-only: permits loopback HTTP origins for the OIDC endpoints (doc 31).
  allowLoopbackHttp: boolean
  // Prefer the RFC 8252 loopback redirect; the pie:// deep link is the fallback.
  preferLoopback: boolean
}

/**
 * Dev-gated like pie-realtime: the login flow is available only when an explicit
 * discovery URL is provided (PIE_AUTH_DISCOVERY_URL). There is NO production
 * auto-start — connection profiles + real discovery selection are a later slice.
 * Loopback HTTP is permitted only when explicitly enabled for local dev.
 */
export function loadPieAuthConfig(env: NodeJS.ProcessEnv = process.env): PieAuthConfig {
  const discoveryUrl = env.PIE_AUTH_DISCOVERY_URL?.trim() || null
  return {
    enabled: Boolean(discoveryUrl),
    discoveryUrl,
    profileId: env.PIE_AUTH_PROFILE_ID?.trim() || 'default',
    allowLoopbackHttp: env.PIE_AUTH_ALLOW_LOOPBACK_HTTP === '1',
    preferLoopback: env.PIE_AUTH_PREFER_DEEPLINK !== '1'
  }
}
