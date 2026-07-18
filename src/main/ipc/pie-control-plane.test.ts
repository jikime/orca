import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PIE_CONTROL_PLANE_CALL_CHANNEL } from '../../shared/pie-control-plane-ipc'

const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, input: unknown) => Promise<unknown>) =>
      handlers.set(channel, fn),
    removeHandler: () => handlers.delete(PIE_CONTROL_PLANE_CALL_CHANNEL)
  }
}))
vi.mock('./pie-renderer-trust', () => ({ assertTrustedPieMainFrame: () => {} }))

const { registerPieControlPlaneHandlers } = await import('./pie-control-plane')

type Call = { url: string; init: RequestInit }

function setup(overrides: { token?: string | null } = {}): {
  calls: Call[]
  fetchImpl: typeof fetch
} {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch
  registerPieControlPlaneHandlers({
    getApiBaseUrl: () => 'http://127.0.0.1:58124/v1',
    getAccessToken: () => (overrides.token === undefined ? 'tok' : overrides.token),
    getOrganizationId: () => 'org-1',
    forceRefresh: async () => false,
    fetchImpl
  })
  return { calls, fetchImpl }
}

function invoke(input: unknown): Promise<unknown> {
  return handlers.get(PIE_CONTROL_PLANE_CALL_CHANNEL)!({}, input)
}

describe('pie control-plane bridge', () => {
  beforeEach(() => handlers.clear())

  it('forwards an org-scoped GET with the bearer token', async () => {
    const { calls } = setup()
    const res = (await invoke({ method: 'GET', path: '/change-requests' })) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(calls[0]!.url).toBe('http://127.0.0.1:58124/v1/organizations/org-1/change-requests')
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer tok')
  })

  it('sends body + content-type + idempotency-key on a POST', async () => {
    const { calls } = setup()
    await invoke({ method: 'POST', path: '/assets', body: { name: 'a' }, idempotencyKey: 'k1' })
    const headers = new Headers(calls[0]!.init.headers)
    expect(calls[0]!.init.body).toBe('{"name":"a"}')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('idempotency-key')).toBe('k1')
  })

  it('rejects a path that escapes the org scope', async () => {
    setup()
    await expect(invoke({ method: 'GET', path: 'http://evil/x' })).rejects.toThrow()
    await expect(invoke({ method: 'GET', path: '/../../secret' })).rejects.toThrow()
    await expect(invoke({ method: 'GET', path: 'no-leading-slash' })).rejects.toThrow()
  })

  it('rejects a non-whitelisted method', async () => {
    setup()
    await expect(invoke({ method: 'OPTIONS', path: '/x' })).rejects.toThrow()
  })

  it('returns 401 without forwarding when signed out', async () => {
    const { calls } = setup({ token: null })
    const res = (await invoke({ method: 'GET', path: '/assets' })) as {
      ok: boolean
      status: number
    }
    expect(res).toEqual({ ok: false, status: 401, data: { error: 'PIE_NOT_AUTHENTICATED' } })
    expect(calls).toHaveLength(0)
  })
})
