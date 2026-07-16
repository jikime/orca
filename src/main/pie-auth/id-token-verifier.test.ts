import { describe, expect, it } from 'vitest'
import { createRsaTestKey, signRs256Jwt } from './__fixtures__/oidc-auth-harness'
import { verifyIdToken } from './id-token-verifier'

const ISSUER = 'https://issuer.test/realms/pie'
const CLIENT_ID = 'pie-desktop'
const NONCE = 'nonce-abc'
const key = createRsaTestKey()

function jwksFetch(jwk: Record<string, unknown> = key.jwk): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [jwk] })
    }) as Response) as unknown as typeof fetch
}

function idToken(overrides: Record<string, unknown> = {}, signingKey = key): string {
  return signRs256Jwt(
    {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'user-1',
      email: 'u@test',
      email_verified: true,
      name: 'User One',
      nonce: NONCE,
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides
    },
    signingKey
  )
}

async function verify(token: string): Promise<unknown> {
  return verifyIdToken({
    idToken: token,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    expectedNonce: NONCE,
    jwksUri: 'https://issuer.test/certs',
    fetchImpl: jwksFetch()
  })
}

describe('ID token verifier', () => {
  it('accepts a valid token and returns identity claims', async () => {
    const claims = await verify(idToken())
    expect(claims).toMatchObject({ subject: 'user-1', email: 'u@test', emailVerified: true })
  })

  it('rejects a nonce mismatch (AUT-001)', async () => {
    await expect(verify(idToken({ nonce: 'other' }))).rejects.toThrow(/nonce/i)
  })

  it('rejects a wrong issuer', async () => {
    await expect(verify(idToken({ iss: 'https://evil.test' }))).rejects.toThrow(/issuer/i)
  })

  it('rejects a wrong audience', async () => {
    await expect(verify(idToken({ aud: 'another-client' }))).rejects.toThrow(/audience/i)
  })

  it('rejects an expired token', async () => {
    await expect(verify(idToken({ exp: Math.floor(Date.now() / 1000) - 60 }))).rejects.toThrow(
      /expired/i
    )
  })

  it('rejects a token signed by a different key', async () => {
    const attackerKey = createRsaTestKey()
    await expect(verify(idToken({}, attackerKey))).rejects.toThrow(/signature/i)
  })
})
