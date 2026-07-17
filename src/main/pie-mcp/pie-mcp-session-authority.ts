import type { PieSessionState } from '../../shared/pie-session-contract'
import { getPieAuthAccessToken, getPieAuthApiBaseUrl } from '../pie-auth/pie-auth-service-registry'

// The MCP server acts on behalf of the signed-in local user. Permissions come
// from the local session snapshot; the bearer token and base URL come from the
// auth registry getters — never from tool arguments, never logged.
export type PieMcpAuthority = {
  getSession(): PieSessionState
  getAccessToken(): string | null
  getApiBaseUrl(): string | null
}

export type AuthorizedContext = {
  readonly accessToken: string
  readonly apiBaseUrl: string
  readonly organizationId: string
  readonly permissions: readonly string[]
}

export type AuthorityResolution =
  | { ok: true; context: AuthorizedContext }
  | { ok: false; reason: string }

// Only a fully signed-in session may drive tools. reauth_required / signed_out
// yield a clean unauthorized reason rather than a partial (unsafe) call.
export function resolveAuthority(authority: PieMcpAuthority): AuthorityResolution {
  const session = authority.getSession()
  if (session.status !== 'signed_in') {
    return { ok: false, reason: 'local session is not signed in' }
  }
  const accessToken = authority.getAccessToken()
  const apiBaseUrl = authority.getApiBaseUrl()
  if (!accessToken || !apiBaseUrl) {
    return { ok: false, reason: 'local session has no active credential' }
  }
  const permissions = Array.isArray(session.permissions) ? session.permissions : []
  return {
    ok: true,
    context: { accessToken, apiBaseUrl, organizationId: session.organizationId, permissions }
  }
}

export function missingPermissions(
  granted: readonly string[],
  required: readonly string[]
): string[] {
  const held = new Set(granted)
  return required.filter((permission) => !held.has(permission))
}

/** Registry-backed authority for the stdio entry. Session snapshot is injected so
 *  the core stays testable; token/base-URL read from the auth registry getters. */
export function createRegistryAuthority(getSession: () => PieSessionState): PieMcpAuthority {
  return {
    getSession,
    getAccessToken: getPieAuthAccessToken,
    getApiBaseUrl: getPieAuthApiBaseUrl
  }
}
