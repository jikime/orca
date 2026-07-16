import { describe, expect, it } from 'vitest'
import { exchangeAuthorizationCode, refreshAccessToken, TokenExchangeError } from './token-exchange'

function mockFetch(
  status: number,
  body: unknown,
  capture?: (form: URLSearchParams) => void
): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    capture?.(new URLSearchParams(String(init.body)))
    return { ok: status < 400, status, json: async () => body } as Response
  }) as unknown as typeof fetch
}

describe('token exchange', () => {
  it('exchanges an authorization code for tokens and sends no client secret', async () => {
    let sent: URLSearchParams | null = null
    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: 'https://issuer.test/token',
      clientId: 'pie-desktop',
      redirectUri: 'http://127.0.0.1:5000/pie-auth/callback',
      code: 'auth-code',
      codeVerifier: 'verifier',
      fetchImpl: mockFetch(
        200,
        { access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 300 },
        (form) => {
          sent = form
        }
      )
    })
    expect(tokens).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      expiresInSeconds: 300
    })
    expect(sent!.get('grant_type')).toBe('authorization_code')
    expect(sent!.get('code_verifier')).toBe('verifier')
    expect(sent!.get('client_id')).toBe('pie-desktop')
    expect(sent!.has('client_secret')).toBe(false)
  })

  it('rotates the refresh token', async () => {
    const tokens = await refreshAccessToken({
      tokenEndpoint: 'https://issuer.test/token',
      clientId: 'pie-desktop',
      refreshToken: 'old-refresh',
      fetchImpl: mockFetch(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 300 })
    })
    expect(tokens.accessToken).toBe('a2')
    expect(tokens.refreshToken).toBe('r2')
    expect(tokens.idToken).toBeNull()
  })

  it('surfaces the OAuth error without token material on failure', async () => {
    await expect(
      refreshAccessToken({
        tokenEndpoint: 'https://issuer.test/token',
        clientId: 'pie-desktop',
        refreshToken: 'revoked',
        fetchImpl: mockFetch(400, { error: 'invalid_grant', error_description: 'revoked' })
      })
    ).rejects.toBeInstanceOf(TokenExchangeError)
  })
})
