import { createHash, randomBytes } from 'node:crypto'

// PKCE (RFC 7636) + OIDC request parameters, built entirely from node:crypto —
// no OIDC client library. The code verifier is high-entropy and never leaves
// Main; only its S256 challenge travels in the authorization URL.

// 64 random bytes → 86 base64url chars, safely within RFC 7636's 43–128 range.
const VERIFIER_BYTES = 64
// 32 random bytes → 43 base64url chars, within the R1 broker's 32–256 state range.
const STATE_BYTES = 32
const NONCE_BYTES = 32

export type PkcePair = {
  verifier: string
  challenge: string
  method: 'S256'
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

/** A fresh PKCE verifier + S256 challenge. The verifier stays in Main memory. */
export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(VERIFIER_BYTES))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/** A CSRF state value that satisfies the R1 broker's base64url 32–256 pattern. */
export function createStateValue(): string {
  return base64url(randomBytes(STATE_BYTES))
}

/** An OIDC nonce binding the ID token to this request (AUT-001 replay defense). */
export function createNonce(): string {
  return base64url(randomBytes(NONCE_BYTES))
}

export type AuthorizationRequestInput = {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  state: string
  nonce: string
  codeChallenge: string
  // Defaults to the identity scopes; openid is always required for an ID token.
  scope?: string
  // OIDC prompt (e.g. 'login' / 'select_account'). Forces the IdP to re-auth or
  // show the account chooser instead of silently reusing a browser SSO session —
  // used in dev to log two different accounts into two instances.
  prompt?: string
}

/**
 * Builds the system-browser authorization URL (response_type=code + PKCE S256).
 * The code VERIFIER is never included — only the challenge. Scope defaults to
 * `openid email profile` so the ID token carries the identity claims Pie needs.
 */
export function buildAuthorizationUrl(input: AuthorizationRequestInput): string {
  const url = new URL(input.authorizationEndpoint)
  const params = url.searchParams
  params.set('response_type', 'code')
  params.set('client_id', input.clientId)
  params.set('redirect_uri', input.redirectUri)
  params.set('scope', input.scope ?? 'openid email profile')
  params.set('state', input.state)
  params.set('nonce', input.nonce)
  params.set('code_challenge', input.codeChallenge)
  params.set('code_challenge_method', 'S256')
  if (input.prompt) {
    params.set('prompt', input.prompt)
  }
  return url.toString()
}
