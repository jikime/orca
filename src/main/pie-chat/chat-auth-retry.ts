// Reactive auth-retry for the Control Plane (chat) clients. The proactive refresh
// timer can miss (laptop sleep/wake, suspended process), leaving a just-expired
// access token; a request then 401s. This wraps the base fetch so a 401 triggers
// ONE token rotation and ONE retry with the fresh bearer, in-band, instead of
// surfacing the error. Every chat client already receives its fetch here, so it
// wires once with zero changes to the client call sites.

export type AuthedFetchDeps = {
  // Rotates the (likely just-expired) token via the refresh token. Single-flight
  // lives in the auth service, so concurrent 401s collapse to one rotation.
  forceRefresh: () => Promise<boolean>
  // Re-reads the refreshed access token from Main memory after forceRefresh.
  getAccessToken: () => string | null
}

// Swaps only the Authorization header to the rotated bearer, preserving every
// other header (notably the caller's Idempotency-Key) so a retried write is safe.
function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${token}`)
  return { ...init, headers }
}

/**
 * Wraps `baseFetch` into a `typeof fetch` that retries a 401 exactly once after
 * rotating the access token. Non-401 responses pass through untouched; the token
 * is never logged.
 */
export function makeAuthedFetch(baseFetch: typeof fetch, deps: AuthedFetchDeps): typeof fetch {
  return async (input, init) => {
    const first = await baseFetch(input, init)
    if (first.status !== 401) {
      return first
    }
    const refreshed = await deps.forceRefresh()
    if (!refreshed) {
      return first
    }
    const rotated = deps.getAccessToken()
    if (rotated === null) {
      return first
    }
    // retry-once-on-401 with the fresh bearer; same URL/body/Idempotency-Key.
    return baseFetch(input, withBearer(init, rotated))
  }
}
