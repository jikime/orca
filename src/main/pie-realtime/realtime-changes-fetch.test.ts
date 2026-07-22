import { describe, expect, it } from 'vitest'
import { createRealtimeChangesFetcher } from './realtime-changes-fetch'

function captureFetch(): {
  fetchImpl: typeof fetch
  calls: { url: string; headers: Record<string, string> }[]
} {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> })
    return {
      ok: true,
      json: async () => ({ items: [], nextCursor: null, hasMore: false })
    } as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const ORG = '11111111-1111-1111-1111-111111111111'

function change(cursor: string) {
  return {
    type: 'resource.changed',
    schemaVersion: 1,
    eventId: '77777777-7777-4777-8777-777777777777',
    cursor,
    organizationId: '11111111-1111-4111-8111-111111111111',
    resourceType: 'meeting',
    resourceId: '66666666-6666-4666-8666-666666666666',
    changeKind: 'updated',
    version: 1,
    occurredAt: '2026-07-20T12:00:00.000Z'
  }
}

describe('realtime changes fetch (R3 auth)', () => {
  it('sends the bearer access token and NOT the x-pie-organization-id stand-in', async () => {
    const { fetchImpl, calls } = captureFetch()
    const fetcher = createRealtimeChangesFetcher({
      apiBaseUrl: 'http://127.0.0.1:8080',
      organizationId: ORG,
      getAccessToken: () => 'access-token-xyz',
      fetchImpl
    })
    await fetcher(null)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.authorization).toBe('Bearer access-token-xyz')
    expect(calls[0]!.headers).not.toHaveProperty('x-pie-organization-id')
    // The org stays in the path per the contract.
    expect(calls[0]!.url).toContain(`/v1/organizations/${ORG}/changes`)
  })

  it('omits the authorization header when signed out (no token)', async () => {
    const { fetchImpl, calls } = captureFetch()
    const fetcher = createRealtimeChangesFetcher({
      apiBaseUrl: 'http://127.0.0.1:8080',
      organizationId: ORG,
      getAccessToken: () => null,
      fetchImpl
    })
    await fetcher('cursor-00000001')
    expect(calls[0]!.headers).not.toHaveProperty('authorization')
    expect(calls[0]!.headers).not.toHaveProperty('x-pie-organization-id')
  })

  it('follows every recovery page until the server reports convergence', async () => {
    const calls: string[] = []
    const pages = [
      { items: [change('cursor-00000001')], nextCursor: 'cursor-00000001', hasMore: true },
      { items: [change('cursor-00000002')], nextCursor: 'cursor-00000002', hasMore: false }
    ]
    const fetcher = createRealtimeChangesFetcher({
      apiBaseUrl: 'http://127.0.0.1:8080',
      organizationId: ORG,
      getAccessToken: () => 'token',
      fetchImpl: (async (url: string) => {
        calls.push(String(url))
        return { ok: true, json: async () => pages.shift() } as Response
      }) as typeof fetch
    })

    const changes = await fetcher(null)
    expect(changes.map((item) => item.cursor)).toEqual(['cursor-00000001', 'cursor-00000002'])
    expect(calls[1]).toContain('after=cursor-00000001')
  })

  it('rejects a non-advancing recovery cursor', async () => {
    const fetcher = createRealtimeChangesFetcher({
      apiBaseUrl: 'http://127.0.0.1:8080',
      organizationId: ORG,
      getAccessToken: () => 'token',
      fetchImpl: (async () =>
        ({
          ok: true,
          json: async () => ({ items: [], nextCursor: 'cursor-stuck', hasMore: true })
        }) as Response) as typeof fetch
    })
    await expect(fetcher('cursor-stuck')).rejects.toThrow(/non-advancing cursor/)
  })
})
