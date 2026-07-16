import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { PieAuthCallbackBroker } from '../pie-deep-link/pie-auth-callback'
import { InMemoryDesktopSessionBroker } from '../pie-session/desktop-session-broker'
import { PieSessionTokenLifecycle } from '../pie-session/pie-session-token-lifecycle'
import type {
  PieSessionSecret,
  PieSessionSecretReadResult,
  PieSessionSecretScope,
  SessionSecretStore
} from '../pie-session/session-secret-store'
import type { PieSessionChanged, PieSessionState } from '../../shared/pie-session-contract'
import { createPieAuthService } from './pie-auth-service'
import {
  startMockControlPlane,
  startMockOidcProvider,
  type MockControlPlane,
  type MockOidcProvider
} from './__fixtures__/oidc-auth-harness'

const CLIENT_ID = 'pie-desktop'

// In-memory SessionSecretStore that records every save so we can canary that ONLY
// the refresh token is ever persisted (access tokens must stay in Main memory).
function recordingStore(): { store: SessionSecretStore; saved: PieSessionSecret[] } {
  const saved: PieSessionSecret[] = []
  const byKey = new Map<string, PieSessionSecret>()
  const keyOf = (scope: PieSessionSecretScope): string =>
    `${scope.instanceId}/${scope.profileId}/${scope.accountId}`
  const store: SessionSecretStore = {
    save: (scope, secret) => {
      saved.push(secret)
      byKey.set(keyOf(scope), secret)
      return { status: 'persisted' }
    },
    read: (scope): PieSessionSecretReadResult => {
      const secret = byKey.get(keyOf(scope))
      return secret ? { status: 'found', secret } : { status: 'missing' }
    },
    delete: (scope) => void byKey.delete(keyOf(scope)),
    clearAccount: (scope) => void byKey.delete(keyOf(scope))
  }
  return { store, saved }
}

type Environment = {
  oidc: MockOidcProvider
  cp: MockControlPlane
  service: ReturnType<typeof createPieAuthService>
  broker: InMemoryDesktopSessionBroker
  saved: PieSessionSecret[]
  events: PieSessionState[]
  triggerRefresh: () => void | Promise<void>
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function makeEnv(options: {
  redirectModes: ('loopback' | 'private_uri_scheme')[]
  nonceTransform?: (nonce: string) => string
}): Promise<Environment> {
  const oidc = await startMockOidcProvider(CLIENT_ID)
  const cp = await startMockControlPlane({
    issuer: oidc.issuer,
    clientId: CLIENT_ID,
    redirectModes: options.redirectModes
  })
  cleanups.push(
    () => oidc.stop(),
    () => cp.stop()
  )

  const broker = new InMemoryDesktopSessionBroker('pie-test')
  const events: PieSessionState[] = []
  broker.subscribe((event: PieSessionChanged) => events.push(event.session))
  const { store, saved } = recordingStore()
  const lifecycle = new PieSessionTokenLifecycle(store, broker)
  const deepLinkBroker = new PieAuthCallbackBroker()

  let refreshFn: (() => void) | null = null
  const openAuthorizationUrl = async (authUrl: string): Promise<void> => {
    const url = new URL(authUrl)
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    const state = url.searchParams.get('state') ?? ''
    const nonce = options.nonceTransform
      ? options.nonceTransform(url.searchParams.get('nonce') ?? '')
      : (url.searchParams.get('nonce') ?? '')
    const code = `code-${randomUUID()}`
    oidc.registerAuthCode(code, { sub: 'kc-sub-1', email: 'u@test', emailVerified: true, nonce })
    if (redirectUri.startsWith('pie://')) {
      deepLinkBroker.dispatch(`${redirectUri}?code=${code}&state=${state}`)
    } else {
      await fetch(`${redirectUri}?code=${code}&state=${encodeURIComponent(state)}`)
    }
  }

  const service = createPieAuthService({
    openAuthorizationUrl,
    lifecycle,
    store,
    broker: deepLinkBroker,
    sessionBroker: broker,
    config: {
      enabled: true,
      discoveryUrl: cp.discoveryUrl,
      profileId: 'default',
      allowLoopbackHttp: true,
      preferLoopback: options.redirectModes.includes('loopback')
    },
    isDisabled: () => false,
    callbackTimeoutMs: 3000,
    scheduleRefresh: (fn) => {
      refreshFn = fn
      return { clear: () => {} }
    }
  })
  cleanups.push(() => service.stop())

  return {
    oidc,
    cp,
    service,
    broker,
    saved,
    events,
    triggerRefresh: () => refreshFn?.()
  }
}

describe('pie-auth-service login vertical', () => {
  it('runs loopback login end to end and publishes a signed-in session', async () => {
    const env = await makeEnv({ redirectModes: ['loopback'] })
    const session = await env.service.login()
    expect(session.status).toBe('signed_in')
    expect(env.broker.getState().status).toBe('signed_in')
    expect(env.service.getStatus().state).toBe('signed_in')
    expect(env.events.at(-1)?.status).toBe('signed_in')
  })

  it('persists ONLY the refresh token; no token strings reach the session broker', async () => {
    const env = await makeEnv({ redirectModes: ['loopback'] })
    await env.service.login()
    // The store only ever receives the refresh token (access lives in Main memory).
    expect(env.saved.length).toBeGreaterThanOrEqual(1)
    const refreshToken = env.saved[0]!.refreshToken
    expect(refreshToken).toMatch(/^refresh-/)
    for (const secret of env.saved) {
      expect(secret).not.toHaveProperty('accessToken')
    }
    // No published session contains any token material (canary).
    const serialized = JSON.stringify(env.events)
    expect(serialized).not.toContain(refreshToken)
    expect(serialized).not.toContain('access-')
    for (const key of ['accessToken', 'refreshToken', 'idToken']) {
      expect(serialized).not.toContain(key)
    }
  })

  it('rotates both tokens before expiry via the lifecycle', async () => {
    const env = await makeEnv({ redirectModes: ['loopback'] })
    await env.service.login()
    const firstRefresh = env.saved.at(-1)!.refreshToken
    await env.triggerRefresh()
    const rotatedRefresh = env.saved.at(-1)!.refreshToken
    expect(rotatedRefresh).not.toBe(firstRefresh)
    expect(rotatedRefresh).toMatch(/^refresh-rotated-/)
  })

  it('drops to reauth_required when the refresh grant fails', async () => {
    const env = await makeEnv({ redirectModes: ['loopback'] })
    await env.service.login()
    env.oidc.failNextRefresh()
    await env.triggerRefresh()
    expect(env.broker.getState().status).toBe('reauth_required')
    expect(env.service.getStatus().state).toBe('reauth_required')
  })

  it('rejects the login when the ID token nonce does not match', async () => {
    const env = await makeEnv({
      redirectModes: ['loopback'],
      nonceTransform: () => 'tampered-nonce'
    })
    await expect(env.service.login()).rejects.toThrow(/nonce/i)
    expect(env.broker.getState().status).toBe('signed_out')
  })

  it('clears the session on logout', async () => {
    const env = await makeEnv({ redirectModes: ['loopback'] })
    await env.service.login()
    await env.service.logout()
    expect(env.broker.getState().status).toBe('signed_out')
    expect(env.service.getStatus().state).toBe('idle')
  })

  it('falls back to the pie:// deep-link channel when loopback is unavailable', async () => {
    const env = await makeEnv({ redirectModes: ['private_uri_scheme'] })
    const session = await env.service.login()
    expect(session.status).toBe('signed_in')
    expect(env.broker.getState().status).toBe('signed_in')
  })
})
