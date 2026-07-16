import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildAuthorizationUrl,
  createNonce,
  createPkcePair,
  createStateValue
} from './pkce-authorization-request'

const BASE64URL = /^[A-Za-z0-9_-]+$/

describe('PKCE authorization request', () => {
  it('produces an RFC 7636 verifier and matching S256 challenge', () => {
    const pair = createPkcePair()
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pair.verifier.length).toBeLessThanOrEqual(128)
    expect(pair.verifier).toMatch(BASE64URL)
    expect(pair.method).toBe('S256')
    const expectedChallenge = createHash('sha256')
      .update(pair.verifier)
      .digest()
      .toString('base64url')
    expect(pair.challenge).toBe(expectedChallenge)
  })

  it('generates state that fits the R1 broker pattern (base64url, 32–256)', () => {
    const state = createStateValue()
    expect(state).toMatch(BASE64URL)
    expect(state.length).toBeGreaterThanOrEqual(32)
    expect(state.length).toBeLessThanOrEqual(256)
  })

  it('builds an authorization URL with the challenge + S256, never the verifier', () => {
    const pair = createPkcePair()
    const state = createStateValue()
    const nonce = createNonce()
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: 'https://issuer.test/authorize',
        clientId: 'pie-desktop',
        redirectUri: 'http://127.0.0.1:5000/pie-auth/callback',
        state,
        nonce,
        codeChallenge: pair.challenge
      })
    )
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge')).toBe(pair.challenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(state)
    expect(url.searchParams.get('nonce')).toBe(nonce)
    expect(url.searchParams.get('scope')).toContain('openid')
    // The verifier must never appear anywhere in the authorization URL.
    expect(url.toString()).not.toContain(pair.verifier)
  })

  it('uniqueness: two pairs never collide', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier)
    expect(createStateValue()).not.toBe(createStateValue())
  })
})
