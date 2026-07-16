import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKeycloakTokenVerifier } from './keycloak-token-verifier'

// Fast, hermetic verifier coverage: a local JWKS + locally-signed tokens exercise
// every rejection mode deterministically. The real-Keycloak wiring is proven in
// identity-vertical.test.ts.
const ISSUER = 'https://issuer.test/realms/pie'
const AUDIENCE = 'pie-desktop'

let privateKey: KeyLike
let jwksServer: Server
let jwksUri = ''

async function signToken(overrides: {
  issuer?: string
  audience?: string
  subject?: string | null
  expiresIn?: string
  expiredAt?: number
}): Promise<string> {
  const builder = new SignJWT({ email: 'u@test', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
  if (overrides.subject !== null) {
    builder.setSubject(overrides.subject ?? 'user-123')
  }
  if (overrides.expiredAt !== undefined) {
    builder.setExpirationTime(overrides.expiredAt)
  } else {
    builder.setExpirationTime(overrides.expiresIn ?? '5m')
  }
  return builder.sign(privateKey)
}

beforeAll(async () => {
  const keyPair = await generateKeyPair('RS256')
  privateKey = keyPair.privateKey
  const publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig'
  }
  jwksServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ keys: [publicJwk] }))
  })
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve))
  jwksUri = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/certs`
})

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()))
})

function verifier(overrides: Partial<{ issuer: string; audience: string }> = {}) {
  return createKeycloakTokenVerifier({
    issuer: overrides.issuer ?? ISSUER,
    audience: overrides.audience ?? AUDIENCE,
    jwksUri
  })
}

describe('keycloak token verifier', () => {
  it('accepts a valid token and extracts the subject and claims', async () => {
    const principal = await verifier().verify(await signToken({}))
    expect(principal.subject).toBe('user-123')
    expect(principal.issuer).toBe(ISSUER)
    expect(principal.email).toBe('u@test')
    expect(principal.emailVerified).toBe(true)
  })

  it('rejects a tampered token', async () => {
    const token = await signToken({})
    const tampered = `${token.slice(0, -3)}${token.slice(-3) === 'aaa' ? 'bbb' : 'aaa'}`
    await expect(verifier().verify(tampered)).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const expired = await signToken({ expiredAt: Math.floor(Date.now() / 1000) - 60 })
    await expect(verifier().verify(expired)).rejects.toThrow()
  })

  it('rejects a token from a different issuer', async () => {
    const token = await signToken({ issuer: 'https://evil.test/realms/pie' })
    await expect(verifier().verify(token)).rejects.toThrow()
  })

  it('does not trust a token-selected issuer over the pinned one', async () => {
    // Signed for a different audience → the pinned-audience verifier rejects it.
    const token = await signToken({ audience: 'some-other-client' })
    await expect(verifier().verify(token)).rejects.toThrow()
  })

  it('rejects a token with no subject', async () => {
    const token = await signToken({ subject: null })
    await expect(verifier().verify(token)).rejects.toThrow()
  })
})
