import { describe, expect, it } from 'vitest'
import { fetchOidcDiscovery, isAllowedEndpointOrigin } from './oidc-discovery'

const ISSUER = 'https://issuer.test/realms/pie'

function discoveryDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
    ...overrides
  }
}

function mockFetch(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response) as unknown as typeof fetch
}

describe('OIDC discovery', () => {
  it('accepts a document whose issuer matches exactly', async () => {
    const doc = await fetchOidcDiscovery({
      issuer: ISSUER,
      allowLoopbackHttp: false,
      fetchImpl: mockFetch(discoveryDoc())
    })
    expect(doc.token_endpoint).toBe(`${ISSUER}/protocol/openid-connect/token`)
  })

  it('rejects an issuer that does not match the pinned issuer', async () => {
    await expect(
      fetchOidcDiscovery({
        issuer: ISSUER,
        allowLoopbackHttp: false,
        fetchImpl: mockFetch(discoveryDoc({ issuer: 'https://evil.test/realms/pie' }))
      })
    ).rejects.toThrow(/issuer/i)
  })

  it('rejects a non-HTTPS, non-loopback endpoint', async () => {
    await expect(
      fetchOidcDiscovery({
        issuer: ISSUER,
        allowLoopbackHttp: false,
        fetchImpl: mockFetch(discoveryDoc({ token_endpoint: 'http://cdn.evil.test/token' }))
      })
    ).rejects.toThrow(/allowed origin/i)
  })

  it('permits loopback HTTP only when the dev exception is enabled', async () => {
    const loopbackIssuer = 'http://127.0.0.1:8088/realms/pie'
    const doc = discoveryDoc({
      issuer: loopbackIssuer,
      authorization_endpoint: `${loopbackIssuer}/auth`,
      token_endpoint: `${loopbackIssuer}/token`,
      jwks_uri: `${loopbackIssuer}/certs`
    })
    await expect(
      fetchOidcDiscovery({
        issuer: loopbackIssuer,
        allowLoopbackHttp: false,
        fetchImpl: mockFetch(doc)
      })
    ).rejects.toThrow(/allowed origin/i)
    const ok = await fetchOidcDiscovery({
      issuer: loopbackIssuer,
      allowLoopbackHttp: true,
      fetchImpl: mockFetch(doc)
    })
    expect(ok.issuer).toBe(loopbackIssuer)
  })

  it('origin rule: https always, http only for loopback under the dev flag', () => {
    expect(isAllowedEndpointOrigin('https://any.test/x', false)).toBe(true)
    expect(isAllowedEndpointOrigin('http://127.0.0.1:9000/x', true)).toBe(true)
    expect(isAllowedEndpointOrigin('http://127.0.0.1:9000/x', false)).toBe(false)
    expect(isAllowedEndpointOrigin('http://example.test/x', true)).toBe(false)
  })
})
