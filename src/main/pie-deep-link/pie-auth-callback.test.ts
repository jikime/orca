import { describe, expect, it, vi } from 'vitest'
import {
  parsePieAuthCallbackUrl,
  PieAuthCallbackBroker,
  type PieAuthCallback
} from './pie-auth-callback'

const STATE = 'qwertyuiopasdfghjklzxcvbnm123456'

describe('parsePieAuthCallbackUrl', () => {
  it('accepts the exact success callback route', () => {
    expect(parsePieAuthCallbackUrl(`pie://auth/callback?code=abc_123&state=${STATE}`)).toEqual({
      callback: { authorizationCode: 'abc_123', outcome: 'success', state: STATE },
      ok: true
    })
  })

  it('accepts a bounded OAuth error without propagating its untrusted description', () => {
    expect(
      parsePieAuthCallbackUrl(
        `pie://auth/callback?error=access_denied&error_description=No%20access&state=${STATE}`
      )
    ).toEqual({
      callback: { errorCode: 'access_denied', outcome: 'error', state: STATE },
      ok: true
    })
  })

  it.each([
    `https://auth/callback?code=abc&state=${STATE}`,
    `pie://support/callback?code=abc&state=${STATE}`,
    `pie://auth/other?code=abc&state=${STATE}`,
    `pie://auth/x/../callback?code=abc&state=${STATE}`,
    `pie://auth./callback?code=abc&state=${STATE}`,
    `pie://user@auth/callback?code=abc&state=${STATE}`,
    `pie://auth/callback?code=abc&state=${STATE}#fragment`
  ])('rejects a callback outside the exact protocol route: %s', (url) => {
    expect(parsePieAuthCallbackUrl(url)).toEqual({ ok: false, reason: 'invalid-route' })
  })

  it.each([
    `pie://auth/callback?code=first&code=second&state=${STATE}`,
    `pie://auth/callback?code=abc&state=${STATE}&state=${STATE}`,
    `pie://auth/callback?code=abc&error=access_denied&state=${STATE}`,
    `pie://auth/callback?access_token=secret&state=${STATE}`,
    `pie://auth/callback?code=abc&state=${STATE}&next=terminal`
  ])('rejects duplicate, token-bearing, or unknown query parameters: %s', (url) => {
    expect(parsePieAuthCallbackUrl(url).ok).toBe(false)
  })

  it('rejects states outside the generated base64url contract', () => {
    expect(parsePieAuthCallbackUrl('pie://auth/callback?code=abc&state=short')).toEqual({
      ok: false,
      reason: 'invalid-state'
    })
    expect(
      parsePieAuthCallbackUrl(`pie://auth/callback?code=abc&state=${STATE}%20not-safe`)
    ).toEqual({ ok: false, reason: 'invalid-state' })
  })

  it('rejects malformed percent encoding before URL normalization', () => {
    expect(parsePieAuthCallbackUrl(`pie://auth/callback?code=%ZZ&state=${STATE}`)).toEqual({
      ok: false,
      reason: 'invalid-url'
    })
  })
})

describe('PieAuthCallbackBroker', () => {
  it('delivers a matching callback exactly once', () => {
    let nowMs = 1_000
    const broker = new PieAuthCallbackBroker(() => nowMs)
    const onCallback = vi.fn<(callback: PieAuthCallback) => void>()
    broker.registerExpectedCallback({ expiresAtMs: 2_000, onCallback, state: STATE })

    const url = `pie://auth/callback?code=abc&state=${STATE}`
    expect(broker.dispatch(url)).toEqual({ status: 'delivered' })
    expect(onCallback).toHaveBeenCalledWith({
      authorizationCode: 'abc',
      outcome: 'success',
      state: STATE
    })

    nowMs += 1
    expect(broker.dispatch(url)).toEqual({ reason: 'replayed-state', status: 'rejected' })
    expect(onCallback).toHaveBeenCalledTimes(1)
  })

  it('rejects callbacks that do not match an in-memory pending state', () => {
    const broker = new PieAuthCallbackBroker(() => 1_000)
    expect(broker.dispatch(`pie://auth/callback?code=abc&state=${STATE}`)).toEqual({
      reason: 'unexpected-state',
      status: 'rejected'
    })
  })

  it('consumes an expired state without invoking its handler', () => {
    let nowMs = 1_000
    const broker = new PieAuthCallbackBroker(() => nowMs)
    const onCallback = vi.fn()
    broker.registerExpectedCallback({ expiresAtMs: 1_500, onCallback, state: STATE })
    nowMs = 1_500

    expect(broker.dispatch(`pie://auth/callback?code=abc&state=${STATE}`)).toEqual({
      reason: 'expired-state',
      status: 'rejected'
    })
    expect(onCallback).not.toHaveBeenCalled()
  })

  it('marks cancelled states as consumed to block delayed callbacks', () => {
    const broker = new PieAuthCallbackBroker(() => 1_000)
    const cancel = broker.registerExpectedCallback({
      expiresAtMs: 2_000,
      onCallback: vi.fn(),
      state: STATE
    })
    cancel()

    expect(broker.dispatch(`pie://auth/callback?code=abc&state=${STATE}`)).toEqual({
      reason: 'replayed-state',
      status: 'rejected'
    })
  })

  it('consumes the state before a failing handler can trigger a replay', () => {
    const broker = new PieAuthCallbackBroker(() => 1_000)
    broker.registerExpectedCallback({
      expiresAtMs: 2_000,
      onCallback: () => {
        throw new Error('exchange failed')
      },
      state: STATE
    })
    const url = `pie://auth/callback?code=abc&state=${STATE}`

    expect(broker.dispatch(url)).toEqual({ reason: 'handler-failed', status: 'rejected' })
    expect(broker.dispatch(url)).toEqual({ reason: 'replayed-state', status: 'rejected' })
  })

  it('rejects invalid expiry and duplicate state registration', () => {
    const broker = new PieAuthCallbackBroker(() => 1_000)
    expect(() =>
      broker.registerExpectedCallback({ expiresAtMs: 1_000, onCallback: vi.fn(), state: STATE })
    ).toThrow('expiry')

    broker.registerExpectedCallback({ expiresAtMs: 2_000, onCallback: vi.fn(), state: STATE })
    expect(() =>
      broker.registerExpectedCallback({ expiresAtMs: 2_000, onCallback: vi.fn(), state: STATE })
    ).toThrow('already registered')
  })
})
