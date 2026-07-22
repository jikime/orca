import { randomUUID } from 'node:crypto'
import { PieInstanceDiscoverySchema } from '../../shared/pie-instance-discovery'
import type { PieSessionState } from '../../shared/pie-session-contract'
import { isSafeModeSubsystemDisabled } from '../pie-safe-mode/safe-mode-state'
import {
  pieAuthCallbackBroker,
  type PieAuthCallbackBroker
} from '../pie-deep-link/pie-auth-callback'
import {
  desktopSessionBroker,
  type DesktopSessionBroker
} from '../pie-session/desktop-session-broker'
import type { PieSessionTokenLifecycle } from '../pie-session/pie-session-token-lifecycle'
import type { PieSessionSecretScope, SessionSecretStore } from '../pie-session/session-secret-store'
import { createDeepLinkCallbackChannel, type CallbackChannel } from './callback-channel'
import { startLoopbackCallbackChannel } from './loopback-callback-server'
import { fetchOidcDiscovery } from './oidc-discovery'
import { loadPieAuthConfig, type PieAuthConfig } from './pie-auth-config'
import {
  buildAuthorizationUrl,
  createNonce,
  createPkcePair,
  createStateValue
} from './pkce-authorization-request'
import { acceptInvite as acceptInviteRequest, resolveSessionState } from './platform-session-client'
import { verifyIdToken } from './id-token-verifier'
import { exchangeAuthorizationCode } from './token-exchange'
import { createRefreshRunner } from './refresh-token-rotation'

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_REFRESH_SKEW_SECONDS = 60

export type PieAuthStatus =
  | { state: 'disabled' }
  | { state: 'idle' }
  | { state: 'signed_in'; organizationId: string }
  | { state: 'reauth_required' }

export type PieAuthServiceDeps = {
  // shell.openExternal in production — NEVER an embedded webview (RFC 8252).
  openAuthorizationUrl: (url: string) => Promise<void>
  lifecycle: PieSessionTokenLifecycle
  store: SessionSecretStore
  // The deep-link broker (auth callbacks) and the session broker (renderer state)
  // are distinct; reauth_required is a UI-state signal, published via the latter.
  broker?: PieAuthCallbackBroker
  sessionBroker?: DesktopSessionBroker
  config?: PieAuthConfig
  fetchImpl?: typeof fetch
  now?: () => number
  isDisabled?: () => boolean
  callbackTimeoutMs?: number
  refreshSkewSeconds?: number
  // Test seam so the refresh timer is drivable without real time. The fn may be
  // async so a test can await the rotation it triggers.
  scheduleRefresh?: (fn: () => void | Promise<void>, ms: number) => { clear: () => void }
  onSessionAuthenticated?: () => void
  onSessionUnavailable?: () => void
}

export type PieAuthService = {
  login: () => Promise<PieSessionState>
  // Accepts a pie://invite token: logs in first if needed, then joins the org.
  acceptInvite: (inviteToken: string) => Promise<{ organizationId: string }>
  logout: () => Promise<void>
  stop: () => void
  getStatus: () => PieAuthStatus
  // The active session's access token (Main-memory only), or null when signed
  // out. Used by other Main subsystems (e.g. realtime) to authenticate — never
  // exposed to the renderer.
  getAccessToken: () => string | null
  // The control-plane API base URL (includes /v1) for the active login, or null.
  // Main-only — lets other subsystems (e.g. chat) reach the REST surface.
  getApiBaseUrl: () => string | null
  // Reactively rotate the access token via the refresh token (e.g. after a 401
  // when the proactive timer missed). Single-flight, so concurrent callers share
  // one rotation. Resolves true when a fresh token is available, false otherwise.
  forceRefresh: () => Promise<boolean>
}

type ActiveSession = {
  scope: PieSessionSecretScope
  session: PieSessionState
  apiBaseUrl: string
  tokenEndpoint: string
  clientId: string
  endSessionEndpoint: string | undefined
  refreshTimer: { clear: () => void } | null
}

export function createPieAuthService(deps: PieAuthServiceDeps): PieAuthService {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const config = deps.config ?? loadPieAuthConfig()
  const broker = deps.broker ?? pieAuthCallbackBroker
  const sessionBroker = deps.sessionBroker ?? desktopSessionBroker
  const isDisabled = deps.isDisabled ?? (() => isSafeModeSubsystemDisabled('pie-auth'))
  const callbackTimeoutMs = deps.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS
  const refreshSkewSeconds = deps.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS
  const scheduleRefresh =
    deps.scheduleRefresh ??
    ((fn, ms) => {
      const timer = setTimeout(() => void fn(), ms)
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref()
      }
      return { clear: () => clearTimeout(timer) }
    })

  let active: ActiveSession | null = null
  let status: PieAuthStatus = config.enabled ? { state: 'idle' } : { state: 'disabled' }

  async function openChannel(
    redirectModes: readonly string[],
    state: string
  ): Promise<CallbackChannel> {
    if (config.preferLoopback && redirectModes.includes('loopback')) {
      return startLoopbackCallbackChannel({ expectedState: state, timeoutMs: callbackTimeoutMs })
    }
    if (redirectModes.includes('private_uri_scheme')) {
      return createDeepLinkCallbackChannel({
        broker,
        state,
        expiresAtMs: now() + callbackTimeoutMs,
        timeoutMs: callbackTimeoutMs
      })
    }
    throw new Error('no supported redirect mode in instance discovery')
  }

  function scheduleNextRefresh(expiresInSeconds: number): void {
    const delayMs = Math.max(expiresInSeconds - refreshSkewSeconds, 5) * 1000
    if (active) {
      active.refreshTimer = scheduleRefresh(() => runRefresh(), delayMs)
    }
  }

  // Single-flight rotation shared by the proactive timer and reactive forceRefresh.
  const performRefresh = createRefreshRunner({
    store: deps.store,
    lifecycle: deps.lifecycle,
    fetchImpl,
    getContext: () =>
      active
        ? { scope: active.scope, tokenEndpoint: active.tokenEndpoint, clientId: active.clientId }
        : null,
    onRotated: (expiresInSeconds) => scheduleNextRefresh(expiresInSeconds),
    onReauthRequired: () => declareReauthRequired()
  })

  function runRefresh(): Promise<void> {
    return performRefresh().then(() => undefined)
  }

  function declareReauthRequired(): void {
    if (!active || active.session.status === 'signed_out') {
      return
    }
    active.refreshTimer?.clear()
    active.refreshTimer = null
    const reauth: PieSessionState = { ...active.session, status: 'reauth_required' }
    active.session = reauth
    status = { state: 'reauth_required' }
    // Publish the UI-state transition; no token is involved.
    sessionBroker.replaceSession({
      session: reauth,
      sessionId: sessionBroker.getContext().sessionId
    })
    deps.onSessionUnavailable?.()
  }

  async function login(): Promise<PieSessionState> {
    if (!config.enabled || !config.discoveryUrl) {
      throw new Error('pie-auth is not enabled')
    }
    if (isDisabled()) {
      throw new Error('pie-auth is disabled by safe mode')
    }

    const discoveryResponse = await fetchImpl(config.discoveryUrl, {
      headers: { accept: 'application/json' }
    })
    if (!discoveryResponse.ok) {
      throw new Error(`instance discovery failed with ${discoveryResponse.status}`)
    }
    const discovery = PieInstanceDiscoverySchema.parse(await discoveryResponse.json())
    const oidc = await fetchOidcDiscovery({
      issuer: discovery.auth.issuer,
      allowLoopbackHttp: config.allowLoopbackHttp,
      fetchImpl
    })

    // Ephemeral secrets — discarded before this function returns.
    const pkce = createPkcePair()
    const state = createStateValue()
    const nonce = createNonce()
    const channel = await openChannel(discovery.auth.redirectModes, state)

    try {
      const authorizationUrl = buildAuthorizationUrl({
        authorizationEndpoint: oidc.authorization_endpoint,
        clientId: discovery.auth.clientId,
        redirectUri: channel.redirectUri,
        state,
        nonce,
        codeChallenge: pkce.challenge,
        prompt: config.prompt ?? undefined
      })
      await deps.openAuthorizationUrl(authorizationUrl)
      const outcome = await channel.waitForCallback()
      if (outcome.outcome === 'error') {
        throw new Error(`authorization failed: ${outcome.errorCode}`)
      }

      const tokens = await exchangeAuthorizationCode({
        tokenEndpoint: oidc.token_endpoint,
        clientId: discovery.auth.clientId,
        redirectUri: channel.redirectUri,
        code: outcome.code,
        codeVerifier: pkce.verifier,
        fetchImpl
      })
      if (!tokens.idToken) {
        throw new Error('token response missing id_token')
      }
      // Nonce-checked ID-token verification (AUT-001) before trusting the login.
      await verifyIdToken({
        idToken: tokens.idToken,
        issuer: discovery.auth.issuer,
        clientId: discovery.auth.clientId,
        expectedNonce: nonce,
        jwksUri: oidc.jwks_uri,
        fetchImpl,
        now
      })

      const session = await resolveSessionState(discovery.apiBaseUrl, tokens.accessToken, fetchImpl)
      if (session.status === 'signed_out') {
        throw new Error('session did not become signed in after provisioning')
      }
      const scope: PieSessionSecretScope = {
        instanceId: session.instanceId,
        profileId: config.profileId,
        accountId: session.userId
      }
      deps.lifecycle.handleLoginSuccess({
        scope,
        sessionId: randomUUID(),
        session,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken
      })
      active = {
        scope,
        session,
        apiBaseUrl: discovery.apiBaseUrl,
        tokenEndpoint: oidc.token_endpoint,
        clientId: discovery.auth.clientId,
        endSessionEndpoint: oidc.end_session_endpoint,
        refreshTimer: null
      }
      status = { state: 'signed_in', organizationId: session.organizationId }
      scheduleNextRefresh(tokens.expiresInSeconds)
      deps.onSessionAuthenticated?.()
      return session
    } finally {
      channel.close()
    }
  }

  async function logout(): Promise<void> {
    if (!active) {
      return
    }
    const scope = active.scope
    const endSessionEndpoint = active.endSessionEndpoint
    const read = deps.store.read(scope)
    active.refreshTimer?.clear()
    // Best-effort IdP logout (revokes the refresh token); never blocks local logout.
    if (endSessionEndpoint && read.status === 'found') {
      try {
        await fetchImpl(endSessionEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: active.clientId,
            refresh_token: read.secret.refreshToken
          }).toString()
        })
      } catch {
        // Ignore — local logout below is what matters.
      }
    }
    deps.lifecycle.handleLogout(scope)
    active = null
    status = { state: 'idle' }
    deps.onSessionUnavailable?.()
  }

  function stop(): void {
    active?.refreshTimer?.clear()
  }

  async function acceptInvite(inviteToken: string): Promise<{ organizationId: string }> {
    if (!active) {
      await login()
    }
    const session = active
    if (!session) {
      throw new Error('login required to accept an invite')
    }
    const accessToken = deps.lifecycle.getAccessToken(session.scope)
    if (!accessToken) {
      throw new Error('no access token to accept an invite')
    }
    const result = await acceptInviteRequest(
      session.apiBaseUrl,
      accessToken,
      inviteToken,
      fetchImpl
    )
    return { organizationId: result.organizationId }
  }

  return {
    login,
    acceptInvite,
    logout,
    stop,
    getStatus: () => status,
    getAccessToken: () => (active ? deps.lifecycle.getAccessToken(active.scope) : null),
    getApiBaseUrl: () => active?.apiBaseUrl ?? null,
    forceRefresh: () => performRefresh()
  }
}
