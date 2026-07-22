import { makeAuthedFetch } from '../pie-chat/chat-auth-retry'

export type PieChatHandlerDeps = {
  // Resolved in Main so the token and org/user ids never reach the renderer.
  getApiBaseUrl: () => string | null
  getAccessToken: () => string | null
  getOrganizationId: () => string | null
  // Reactively rotate the token on a 401 (see makeAuthedFetch). Optional so tests
  // that inject fetchImpl directly don't need it.
  forceRefresh?: () => Promise<boolean>
  fetchImpl?: typeof fetch
}

// The base fetch every chat client uses, wrapped so a 401 auto-refreshes + retries
// once (unless a test injected its own fetchImpl). Centralizes the wiring so no
// client call site changes.
export function resolveChatFetch(deps: PieChatHandlerDeps): typeof fetch {
  if (deps.fetchImpl) {
    return deps.fetchImpl
  }
  if (!deps.forceRefresh) {
    return fetch
  }
  return makeAuthedFetch(fetch, {
    forceRefresh: deps.forceRefresh,
    getAccessToken: deps.getAccessToken
  })
}

export type ResolvedAuth = { apiBaseUrl: string; accessToken: string; organizationId: string }

export function resolveAuth(deps: PieChatHandlerDeps): ResolvedAuth {
  const apiBaseUrl = deps.getApiBaseUrl()
  const accessToken = deps.getAccessToken()
  const organizationId = deps.getOrganizationId()
  if (!apiBaseUrl || !accessToken || !organizationId) {
    throw new Error('PIE_CHAT_NOT_AUTHENTICATED')
  }
  return { apiBaseUrl, accessToken, organizationId }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertChannelId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('PIE_CHAT_INVALID_REQUEST')
  }
  return value
}

export function assertClientRequestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('PIE_CHAT_INVALID_REQUEST')
  }
  return value
}

export function assertBody(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error('PIE_CHAT_INVALID_REQUEST')
  }
  return value
}

export function assertNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('PIE_CHAT_INVALID_REQUEST')
  }
  return value
}
