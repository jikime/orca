import { describe, expect, it, vi } from 'vitest'
import { makeAuthedFetch } from './chat-auth-retry'

function response(status: number): Response {
  return new Response(status === 200 ? '{}' : null, { status })
}

describe('makeAuthedFetch', () => {
  it('returns a non-401 response without refreshing', async () => {
    const base = vi.fn().mockResolvedValue(response(200))
    const forceRefresh = vi.fn()
    const authed = makeAuthedFetch(base, { forceRefresh, getAccessToken: () => 't' })
    expect((await authed('u', { headers: { authorization: 'Bearer old' } })).status).toBe(200)
    expect(forceRefresh).not.toHaveBeenCalled()
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('on 401 refreshes once and retries with the rotated bearer, preserving other headers', async () => {
    const base = vi.fn().mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200))
    const forceRefresh = vi.fn().mockResolvedValue(true)
    const authed = makeAuthedFetch(base, { forceRefresh, getAccessToken: () => 'fresh' })
    const res = await authed('u', {
      method: 'POST',
      headers: { authorization: 'Bearer old', 'idempotency-key': 'k1' }
    })
    expect(res.status).toBe(200)
    expect(forceRefresh).toHaveBeenCalledTimes(1)
    expect(base).toHaveBeenCalledTimes(2)
    const retryInit = base.mock.calls[1]![1] as RequestInit
    const headers = new Headers(retryInit.headers)
    expect(headers.get('authorization')).toBe('Bearer fresh')
    // The Idempotency-Key must survive so a retried write stays safe.
    expect(headers.get('idempotency-key')).toBe('k1')
  })

  it('returns the original 401 when refresh fails (no retry)', async () => {
    const base = vi.fn().mockResolvedValue(response(401))
    const forceRefresh = vi.fn().mockResolvedValue(false)
    const authed = makeAuthedFetch(base, { forceRefresh, getAccessToken: () => 't' })
    expect((await authed('u')).status).toBe(401)
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('retries at most once — a second 401 is returned, not looped', async () => {
    const base = vi.fn().mockResolvedValue(response(401))
    const forceRefresh = vi.fn().mockResolvedValue(true)
    const authed = makeAuthedFetch(base, { forceRefresh, getAccessToken: () => 'fresh' })
    expect((await authed('u')).status).toBe(401)
    expect(base).toHaveBeenCalledTimes(2)
    expect(forceRefresh).toHaveBeenCalledTimes(1)
  })

  it('does not retry a non-401 error status', async () => {
    const base = vi.fn().mockResolvedValue(response(500))
    const forceRefresh = vi.fn()
    const authed = makeAuthedFetch(base, { forceRefresh, getAccessToken: () => 't' })
    expect((await authed('u')).status).toBe(500)
    expect(forceRefresh).not.toHaveBeenCalled()
  })
})
