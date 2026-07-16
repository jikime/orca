// OAuth token-endpoint grants for the PUBLIC desktop client: client_id only,
// NO secret anywhere (AUT-003). Built on fetch + URLSearchParams — no OIDC
// library. ID-token validation lives in id-token-verifier.ts; the service composes
// the two so a code exchange is followed by a nonce-checked ID-token verification.

export type TokenSet = {
  accessToken: string
  refreshToken: string
  idToken: string | null
  expiresInSeconds: number
}

export class TokenExchangeError extends Error {
  readonly oauthError: string
  constructor(oauthError: string, message: string) {
    super(message)
    this.name = 'TokenExchangeError'
    this.oauthError = oauthError
  }
}

async function postTokenRequest(
  tokenEndpoint: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<TokenSet> {
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: new URLSearchParams(form).toString()
  })
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    id_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!response.ok) {
    // Surface only the OAuth error code/description — never token material.
    throw new TokenExchangeError(body.error ?? 'token_request_failed', body.error_description ?? '')
  }
  if (!body.access_token || !body.refresh_token) {
    throw new TokenExchangeError('invalid_token_response', 'token response missing tokens')
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken: body.id_token ?? null,
    expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : 0
  }
}

export type AuthorizationCodeExchangeInput = {
  tokenEndpoint: string
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
  fetchImpl?: typeof fetch
}

/** Exchanges an authorization code + PKCE verifier for tokens. */
export async function exchangeAuthorizationCode(
  input: AuthorizationCodeExchangeInput
): Promise<TokenSet> {
  return postTokenRequest(
    input.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier
    },
    input.fetchImpl ?? fetch
  )
}

export type RefreshTokenInput = {
  tokenEndpoint: string
  clientId: string
  refreshToken: string
  fetchImpl?: typeof fetch
}

/** Rotates the refresh token and mints a fresh access token. */
export async function refreshAccessToken(input: RefreshTokenInput): Promise<TokenSet> {
  return postTokenRequest(
    input.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId
    },
    input.fetchImpl ?? fetch
  )
}
