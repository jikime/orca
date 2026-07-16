import { describe, expect, it, vi } from 'vitest'
import type { PieSessionChanged, PieSessionState } from '../../shared/pie-session-contract'
import { InMemoryDesktopSessionBroker } from './desktop-session-broker'
import { PieSessionTokenLifecycle } from './pie-session-token-lifecycle'
import type {
  PieSessionSecret,
  PieSessionSecretScope,
  SessionSecretStore
} from './session-secret-store'
import { pieSessionSecretScopeKey } from './session-secret-store'

const ACCESS_TOKEN = 'pie-access-token-only-in-main-memory'
const REFRESH_TOKEN = 'pie-refresh-token-persisted-encrypted'

const INSTANCE_ID = 'local-desktop'
const USER_ID = '0f0e0d0c-0b0a-4a4b-8c8d-1a2b3c4d5e6f'
const OTHER_USER_ID = '9f9e9d9c-9b9a-4a4b-8c8d-6f5e4d3c2b1a'
const ORGANIZATION_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_ORGANIZATION_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const scope: PieSessionSecretScope = {
  instanceId: INSTANCE_ID,
  profileId: 'profile-alpha',
  accountId: USER_ID
}

function signedInSession(overrides: Partial<Record<string, unknown>> = {}): PieSessionState {
  return {
    status: 'signed_in',
    instanceId: INSTANCE_ID,
    userId: USER_ID,
    displayName: 'Pie Tester',
    organizationId: ORGANIZATION_ID,
    permissions: ['project.read'],
    expiresAt: '2026-07-16T12:00:00.000Z',
    ...overrides
  } as PieSessionState
}

class RecordingSecretStore implements SessionSecretStore {
  readonly secrets = new Map<string, PieSessionSecret>()
  readonly calls: string[] = []

  save(saveScope: PieSessionSecretScope, secret: PieSessionSecret) {
    this.calls.push(`save:${pieSessionSecretScopeKey(saveScope)}`)
    this.secrets.set(pieSessionSecretScopeKey(saveScope), secret)
    return { status: 'persisted' as const }
  }

  read(readScope: PieSessionSecretScope) {
    this.calls.push(`read:${pieSessionSecretScopeKey(readScope)}`)
    const secret = this.secrets.get(pieSessionSecretScopeKey(readScope))
    return secret ? { status: 'found' as const, secret } : { status: 'missing' as const }
  }

  delete(deleteScope: PieSessionSecretScope) {
    this.calls.push(`delete:${pieSessionSecretScopeKey(deleteScope)}`)
    this.secrets.delete(pieSessionSecretScopeKey(deleteScope))
  }

  clearAccount(accountScope: PieSessionSecretScope) {
    this.calls.push(`clearAccount:${pieSessionSecretScopeKey(accountScope)}`)
    this.secrets.delete(pieSessionSecretScopeKey(accountScope))
  }
}

function makeLifecycle() {
  const store = new RecordingSecretStore()
  const broker = new InMemoryDesktopSessionBroker(INSTANCE_ID)
  const events: PieSessionChanged[] = []
  broker.subscribe((event) => events.push(event))
  const lifecycle = new PieSessionTokenLifecycle(store, broker, () => 42)
  return { broker, events, lifecycle, store }
}

function login(lifecycle: PieSessionTokenLifecycle) {
  return lifecycle.handleLoginSuccess({
    scope,
    sessionId: SESSION_ID,
    session: signedInSession(),
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN
  })
}

describe('PieSessionTokenLifecycle', () => {
  it('persists only the refresh token on login and keeps the access token in memory', () => {
    const { broker, events, lifecycle, store } = makeLifecycle()
    expect(login(lifecycle)).toEqual({ status: 'persisted' })

    expect(store.secrets.get(pieSessionSecretScopeKey(scope))).toEqual({
      refreshToken: REFRESH_TOKEN,
      savedAt: 42
    })
    expect(JSON.stringify([...store.secrets.values()])).not.toContain(ACCESS_TOKEN)
    expect(lifecycle.getAccessToken(scope)).toBe(ACCESS_TOKEN)

    expect(broker.getState()).toMatchObject({ status: 'signed_in', userId: USER_ID })
    // Why: the broker event is what reaches renderer IPC; it must carry no tokens.
    expect(JSON.stringify(events)).not.toContain(ACCESS_TOKEN)
    expect(JSON.stringify(events)).not.toContain(REFRESH_TOKEN)
    expect(JSON.stringify(broker.getState())).not.toContain(ACCESS_TOKEN)
  })

  it('rejects a login whose scope does not match the session account', () => {
    const { lifecycle, store } = makeLifecycle()
    expect(() =>
      lifecycle.handleLoginSuccess({
        scope: { ...scope, accountId: OTHER_USER_ID },
        sessionId: SESSION_ID,
        session: signedInSession(),
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN
      })
    ).toThrow('does not match the session account')
    expect(store.secrets.size).toBe(0)
  })

  it('rejects a login whose scope targets a different instance', () => {
    const { lifecycle } = makeLifecycle()
    expect(() =>
      lifecycle.handleLoginSuccess({
        scope: { ...scope, instanceId: 'saas.pielab.ai' },
        sessionId: SESSION_ID,
        session: signedInSession(),
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN
      })
    ).toThrow('does not match the session instance')
  })

  it('replaces both tokens on rotation for the active account', () => {
    const { lifecycle, store } = makeLifecycle()
    login(lifecycle)
    expect(
      lifecycle.handleTokenRotation({
        scope,
        accessToken: 'rotated-access-token',
        refreshToken: 'rotated-refresh-token'
      })
    ).toEqual({ status: 'persisted' })
    expect(lifecycle.getAccessToken(scope)).toBe('rotated-access-token')
    expect(store.secrets.get(pieSessionSecretScopeKey(scope))).toEqual({
      refreshToken: 'rotated-refresh-token',
      savedAt: 42
    })
  })

  it('rejects rotation for an account that is not the active session', () => {
    const { lifecycle, store } = makeLifecycle()
    login(lifecycle)
    expect(() =>
      lifecycle.handleTokenRotation({
        scope: { ...scope, accountId: OTHER_USER_ID },
        accessToken: 'stolen-access-token',
        refreshToken: 'stolen-refresh-token'
      })
    ).toThrow('active signed-in account')
    expect(store.secrets.size).toBe(1)
  })

  it('logout deletes the stored secret, drops the access token, and signs out', () => {
    const { broker, lifecycle, store } = makeLifecycle()
    login(lifecycle)
    lifecycle.handleLogout(scope)

    expect(store.calls).toContain(`delete:${pieSessionSecretScopeKey(scope)}`)
    expect(store.secrets.size).toBe(0)
    expect(lifecycle.getAccessToken(scope)).toBeNull()
    expect(broker.getState()).toEqual({ status: 'signed_out', instanceId: INSTANCE_ID })
  })

  it('account removal clears the whole account storage area', () => {
    const { lifecycle, store } = makeLifecycle()
    login(lifecycle)
    lifecycle.handleAccountRemoved(scope)
    expect(store.calls).toContain(`clearAccount:${pieSessionSecretScopeKey(scope)}`)
    expect(lifecycle.getAccessToken(scope)).toBeNull()
  })

  it('logout of a non-active account does not sign out the active session', () => {
    const { broker, lifecycle, store } = makeLifecycle()
    login(lifecycle)
    const otherScope = { ...scope, accountId: OTHER_USER_ID }
    store.save(otherScope, { refreshToken: 'other-refresh-token', savedAt: 1 })

    lifecycle.handleLogout(otherScope)
    expect(store.secrets.has(pieSessionSecretScopeKey(otherScope))).toBe(false)
    expect(broker.getState()).toMatchObject({ status: 'signed_in', userId: USER_ID })
    expect(lifecycle.getAccessToken(scope)).toBe(ACCESS_TOKEN)
  })

  it('organization switch keeps the same account and never touches the secret store', () => {
    const { broker, lifecycle, store } = makeLifecycle()
    login(lifecycle)
    const callsBeforeSwitch = [...store.calls]

    lifecycle.handleOrganizationSwitch(
      scope,
      signedInSession({ organizationId: OTHER_ORGANIZATION_ID })
    )

    expect(store.calls).toEqual(callsBeforeSwitch)
    expect(broker.getState()).toMatchObject({
      status: 'signed_in',
      userId: USER_ID,
      organizationId: OTHER_ORGANIZATION_ID
    })
    expect(lifecycle.getAccessToken(scope)).toBe(ACCESS_TOKEN)
  })

  it('organization switch cannot adopt another account', () => {
    const { lifecycle, store } = makeLifecycle()
    login(lifecycle)
    store.save(
      { ...scope, accountId: OTHER_USER_ID },
      { refreshToken: 'other-refresh-token', savedAt: 1 }
    )

    expect(() =>
      lifecycle.handleOrganizationSwitch(
        { ...scope, accountId: OTHER_USER_ID },
        signedInSession({ userId: OTHER_USER_ID })
      )
    ).toThrow('active signed-in account')
    expect(() =>
      lifecycle.handleOrganizationSwitch(scope, signedInSession({ userId: OTHER_USER_ID }))
    ).toThrow('cannot change the signed-in account')
  })

  it('never hands tokens to console logging during the lifecycle', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { lifecycle } = makeLifecycle()
      login(lifecycle)
      lifecycle.handleTokenRotation({
        scope,
        accessToken: 'rotated-access-token',
        refreshToken: 'rotated-refresh-token'
      })
      lifecycle.handleLogout(scope)
      const logged = JSON.stringify([
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls
      ])
      expect(logged).not.toContain(ACCESS_TOKEN)
      expect(logged).not.toContain(REFRESH_TOKEN)
      expect(logged).not.toContain('rotated-refresh-token')
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})
