import { describe, expect, it } from 'vitest'
import { PieAuthCallbackBroker } from '../pie-deep-link/pie-auth-callback'
import { createDeepLinkCallbackChannel, PIE_AUTH_DEEP_LINK_REDIRECT_URI } from './callback-channel'
import { createStateValue } from './pkce-authorization-request'

describe('deep-link callback channel', () => {
  it('routes a pie://auth/callback dispatch through the real broker', async () => {
    const broker = new PieAuthCallbackBroker()
    const state = createStateValue()
    const channel = createDeepLinkCallbackChannel({
      broker,
      state,
      expiresAtMs: Date.now() + 60_000,
      timeoutMs: 2000
    })
    expect(channel.redirectUri).toBe(PIE_AUTH_DEEP_LINK_REDIRECT_URI)

    const result = channel.waitForCallback()
    const dispatch = broker.dispatch(`pie://auth/callback?code=deep-code&state=${state}`)
    expect(dispatch.status).toBe('delivered')
    await expect(result).resolves.toEqual({ outcome: 'success', code: 'deep-code', state })
  })

  it('surfaces an authorization error callback', async () => {
    const broker = new PieAuthCallbackBroker()
    const state = createStateValue()
    const channel = createDeepLinkCallbackChannel({
      broker,
      state,
      expiresAtMs: Date.now() + 60_000,
      timeoutMs: 2000
    })
    const result = channel.waitForCallback()
    broker.dispatch(`pie://auth/callback?error=access_denied&state=${state}`)
    await expect(result).resolves.toEqual({ outcome: 'error', errorCode: 'access_denied', state })
  })

  it('times out if no callback is dispatched', async () => {
    const broker = new PieAuthCallbackBroker()
    const channel = createDeepLinkCallbackChannel({
      broker,
      state: createStateValue(),
      expiresAtMs: Date.now() + 60_000,
      timeoutMs: 40
    })
    await expect(channel.waitForCallback()).rejects.toThrow(/timed out/i)
    channel.close()
  })
})
