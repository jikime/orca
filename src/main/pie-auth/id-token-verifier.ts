import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'

// ID-token verification with node:crypto ONLY (no jose / no OIDC library, so the
// root lockfile gains nothing). Node imports a JWK directly and verifies RS256/
// ES256, which is all Keycloak issues. Verifying signature + issuer + audience +
// expiry + nonce is required by AUT-001 (the nonce binds the token to this
// specific authorization request, defeating replay/injection).

export type IdTokenClaims = {
  subject: string
  email: string
  emailVerified: boolean
  displayName: string
  expiresAt: string
}

export type VerifyIdTokenInput = {
  idToken: string
  issuer: string
  clientId: string
  expectedNonce: string
  jwksUri: string
  fetchImpl?: typeof fetch
  now?: () => number
}

type Jwk = { kid?: string; alg?: string; kty?: string } & Record<string, unknown>

export class IdTokenVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdTokenVerificationError'
  }
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8')) as Record<string, unknown>
}

const RS256_TO_DIGEST: Record<string, { node: string; ec?: boolean }> = {
  RS256: { node: 'RSA-SHA256' },
  RS384: { node: 'RSA-SHA384' },
  RS512: { node: 'RSA-SHA512' },
  ES256: { node: 'SHA256', ec: true },
  ES384: { node: 'SHA384', ec: true }
}

function verifySignature(
  alg: string,
  signingInput: string,
  signature: Buffer,
  key: KeyObject
): boolean {
  const spec = RS256_TO_DIGEST[alg]
  if (!spec) {
    throw new IdTokenVerificationError(`unsupported ID token algorithm ${alg}`)
  }
  const data = Buffer.from(signingInput, 'ascii')
  if (spec.ec) {
    return cryptoVerify(spec.node, data, { key, dsaEncoding: 'ieee-p1363' }, signature)
  }
  return cryptoVerify(spec.node, data, key, signature)
}

/**
 * Verifies a Keycloak ID token end to end: JWKS signature, exact issuer, audience
 * contains the client, not expired, and nonce matches. Returns the identity
 * claims Pie provisions from. Any failure throws — the caller drops the login.
 */
export async function verifyIdToken(input: VerifyIdTokenInput): Promise<IdTokenClaims> {
  const now = input.now ?? Date.now
  const parts = input.idToken.split('.')
  if (parts.length !== 3) {
    throw new IdTokenVerificationError('malformed ID token')
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string]
  const header = decodeSegment(headerSegment)
  const alg = typeof header.alg === 'string' ? header.alg : ''
  const kid = typeof header.kid === 'string' ? header.kid : undefined

  const fetchImpl = input.fetchImpl ?? fetch
  const jwksResponse = await fetchImpl(input.jwksUri, { headers: { accept: 'application/json' } })
  if (!jwksResponse.ok) {
    throw new IdTokenVerificationError(`JWKS request failed with ${jwksResponse.status}`)
  }
  const jwks = (await jwksResponse.json()) as { keys?: Jwk[] }
  const jwk = (jwks.keys ?? []).find(
    (candidate) => (kid ? candidate.kid === kid : true) && (candidate.alg ?? alg) === alg
  )
  if (!jwk) {
    throw new IdTokenVerificationError('no matching JWK for the ID token')
  }

  const key = createPublicKey({ key: jwk as Record<string, unknown>, format: 'jwk' })
  const signature = Buffer.from(signatureSegment, 'base64url')
  if (!verifySignature(alg, `${headerSegment}.${payloadSegment}`, signature, key)) {
    throw new IdTokenVerificationError('ID token signature is invalid')
  }

  const payload = decodeSegment(payloadSegment)
  if (payload.iss !== input.issuer) {
    throw new IdTokenVerificationError('ID token issuer mismatch')
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.includes(input.clientId)) {
    throw new IdTokenVerificationError('ID token audience does not include the client')
  }
  const exp = typeof payload.exp === 'number' ? payload.exp : 0
  if (exp * 1000 <= now()) {
    throw new IdTokenVerificationError('ID token is expired')
  }
  if (payload.nonce !== input.expectedNonce) {
    throw new IdTokenVerificationError('ID token nonce mismatch')
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new IdTokenVerificationError('ID token has no subject')
  }

  const email = typeof payload.email === 'string' ? payload.email : ''
  const preferredUsername =
    typeof payload.preferred_username === 'string' ? payload.preferred_username : ''
  const name = typeof payload.name === 'string' ? payload.name : ''
  return {
    subject: payload.sub,
    email,
    emailVerified: payload.email_verified === true,
    displayName: name || preferredUsername || email || payload.sub,
    expiresAt: new Date(exp * 1000).toISOString()
  }
}
