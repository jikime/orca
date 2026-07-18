import type { PieSessionTokenLifecycle } from '../pie-session/pie-session-token-lifecycle'
import type { PieSessionSecretScope, SessionSecretStore } from '../pie-session/session-secret-store'
import { refreshAccessToken } from './token-exchange'

export type RefreshRotationContext = {
  scope: PieSessionSecretScope
  tokenEndpoint: string
  clientId: string
}

export type RefreshRunnerDeps = {
  store: SessionSecretStore
  lifecycle: PieSessionTokenLifecycle
  fetchImpl: typeof fetch
  // Live rotation context for the active session, or null when signed out.
  getContext: () => RefreshRotationContext | null
  onRotated: (expiresInSeconds: number) => void
  onReauthRequired: () => void
}

// A single refresh-token rotation shared by the proactive timer and the reactive
// 401 forceRefresh, with single-flight de-dup: a second caller awaits the one
// in-flight rotation instead of racing a competing refresh. Resolves true when a
// new access token is stored, false on any failure (which signals reauth).
export function createRefreshRunner(deps: RefreshRunnerDeps): () => Promise<boolean> {
  let inFlight: Promise<boolean> | null = null

  async function execute(): Promise<boolean> {
    const context = deps.getContext()
    if (!context) {
      return false
    }
    const read = deps.store.read(context.scope)
    if (read.status !== 'found') {
      deps.onReauthRequired()
      return false
    }
    try {
      const tokens = await refreshAccessToken({
        tokenEndpoint: context.tokenEndpoint,
        clientId: context.clientId,
        refreshToken: read.secret.refreshToken,
        fetchImpl: deps.fetchImpl
      })
      deps.lifecycle.handleTokenRotation({
        scope: context.scope,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken
      })
      deps.onRotated(tokens.expiresInSeconds)
      return true
    } catch {
      // Rotation failure → the session needs interactive re-auth (schema state).
      deps.onReauthRequired()
      return false
    }
  }

  return () => {
    inFlight ??= execute().finally(() => {
      inFlight = null
    })
    return inFlight
  }
}
