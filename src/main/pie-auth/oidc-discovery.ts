import { z } from 'zod'

// The subset of the OIDC provider metadata (RFC 8414 / OpenID Discovery) that the
// login flow needs. .passthrough() keeps additive provider fields.
const OidcDiscoveryDocumentSchema = z
  .object({
    issuer: z.string().min(1),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    jwks_uri: z.string().url(),
    userinfo_endpoint: z.string().url().optional(),
    end_session_endpoint: z.string().url().optional()
  })
  .passthrough()

export type OidcDiscoveryDocument = z.infer<typeof OidcDiscoveryDocumentSchema>

export type FetchOidcDiscoveryInput = {
  // The issuer pinned from the Pie instance discovery document. The returned
  // document's `issuer` MUST equal this exactly — the provider cannot redirect
  // trust to a different issuer.
  issuer: string
  // Dev-only exception to the HTTPS rule for loopback origins (doc 31:134-135).
  allowLoopbackHttp: boolean
  fetchImpl?: typeof fetch
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/**
 * Enforces the transport-origin rule (doc 31:134-135): every endpoint must be
 * HTTPS, with a single explicit, gated exception for loopback HTTP in dev.
 */
export function isAllowedEndpointOrigin(rawUrl: string, allowLoopbackHttp: boolean): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol === 'https:') {
    return true
  }
  return allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

export class OidcDiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OidcDiscoveryError'
  }
}

/**
 * Fetches and validates the issuer's OIDC discovery document. Rejects a document
 * whose `issuer` does not exactly match the pinned issuer, or any endpoint that
 * violates the transport-origin rule — so a compromised or spoofed discovery
 * response cannot point the flow at an attacker-controlled endpoint.
 */
export async function fetchOidcDiscovery(
  input: FetchOidcDiscoveryInput
): Promise<OidcDiscoveryDocument> {
  const fetchImpl = input.fetchImpl ?? fetch
  const base = input.issuer.replace(/\/$/, '')
  const response = await fetchImpl(`${base}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' }
  })
  if (!response.ok) {
    throw new OidcDiscoveryError(`discovery request failed with ${response.status}`)
  }
  const parsed = OidcDiscoveryDocumentSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new OidcDiscoveryError('discovery document failed schema validation')
  }
  const document = parsed.data
  if (document.issuer !== input.issuer) {
    throw new OidcDiscoveryError('discovery issuer does not match the pinned issuer')
  }
  const endpoints = [
    document.authorization_endpoint,
    document.token_endpoint,
    document.jwks_uri,
    document.userinfo_endpoint,
    document.end_session_endpoint
  ]
  for (const endpoint of endpoints) {
    if (endpoint && !isAllowedEndpointOrigin(endpoint, input.allowLoopbackHttp)) {
      throw new OidcDiscoveryError(`discovery endpoint is not an allowed origin: ${endpoint}`)
    }
  }
  return document
}
