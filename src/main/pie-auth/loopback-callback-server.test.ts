import { afterEach, describe, expect, it } from 'vitest'
import { startLoopbackCallbackChannel } from './loopback-callback-server'
import type { CallbackChannel } from './callback-channel'

let channel: CallbackChannel | null = null

afterEach(() => {
  channel?.close()
  channel = null
})

describe('loopback callback server', () => {
  it('captures a matching code + state and returns a page with no token material', async () => {
    channel = await startLoopbackCallbackChannel({ expectedState: 'state-1', timeoutMs: 2000 })
    const result = channel.waitForCallback()
    const page = await fetch(`${channel.redirectUri}?code=the-code&state=state-1`)
    const body = await page.text()
    expect(page.status).toBe(200)
    // The page must not leak the authorization code (nor any token).
    expect(body).not.toContain('the-code')
    await expect(result).resolves.toEqual({
      outcome: 'success',
      code: 'the-code',
      state: 'state-1'
    })
  })

  it('rejects a mismatched state', async () => {
    channel = await startLoopbackCallbackChannel({ expectedState: 'state-1', timeoutMs: 2000 })
    // Attach the catch before triggering so the rejection is never momentarily
    // unhandled between the request and the assertion.
    const settled = channel.waitForCallback().then(
      () => ({ ok: true as const }),
      (error: Error) => ({ ok: false as const, error })
    )
    const response = await fetch(`${channel.redirectUri}?code=x&state=WRONG`)
    expect(response.status).toBe(400)
    const outcome = await settled
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.message).toMatch(/state mismatch/i)
  })

  it('is single-shot: the server stops accepting after the first callback', async () => {
    channel = await startLoopbackCallbackChannel({ expectedState: 'state-1', timeoutMs: 2000 })
    const result = channel.waitForCallback()
    const redirectUri = channel.redirectUri
    await fetch(`${redirectUri}?code=x&state=state-1`)
    await result
    // Resolution closes the server, so a second callback can no longer connect.
    await expect(fetch(`${redirectUri}?code=y&state=state-1`)).rejects.toThrow()
  })

  it('times out and rejects when no callback arrives', async () => {
    channel = await startLoopbackCallbackChannel({ expectedState: 'state-1', timeoutMs: 50 })
    await expect(channel.waitForCallback()).rejects.toThrow(/timed out/i)
  })

  it('serves 404 for an unrelated path', async () => {
    channel = await startLoopbackCallbackChannel({ expectedState: 'state-1', timeoutMs: 2000 })
    const base = new URL(channel.redirectUri)
    const response = await fetch(`${base.origin}/not-the-callback`)
    expect(response.status).toBe(404)
    channel.close()
  })
})
