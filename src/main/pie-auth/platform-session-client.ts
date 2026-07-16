import { PieSessionStateSchema, type PieSessionState } from '../../shared/pie-session-contract'

// Thin client for the Control Plane identity endpoints delivered in R3 slice 1.
// The access token is sent as a bearer; it never appears in a log line here.

export class PlatformSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlatformSessionError'
  }
}

function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
}

/**
 * GET /v1/session — resolves the Pie session for the verified token, validated
 * against the shared session-state schema (which also bans token-shaped fields).
 */
export async function fetchSessionState(
  apiBaseUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieSessionState> {
  const response = await fetchImpl(`${apiBaseUrl}/session`, { headers: authHeaders(accessToken) })
  if (!response.ok) {
    throw new PlatformSessionError(`session request failed with ${response.status}`)
  }
  const parsed = PieSessionStateSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PlatformSessionError('session response failed schema validation')
  }
  return parsed.data
}

export type ProvisionResult = {
  organizationId: string
  userId: string
}

/**
 * POST /v1/provisioning — first-login signup→org-creation. Idempotent server-side
 * (issuer+subject), so a retry is safe.
 */
export async function provisionOwner(
  apiBaseUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<ProvisionResult> {
  const response = await fetchImpl(`${apiBaseUrl}/provisioning`, {
    method: 'POST',
    headers: { ...authHeaders(accessToken), 'content-type': 'application/json' },
    body: '{}'
  })
  if (!response.ok) {
    throw new PlatformSessionError(`provisioning failed with ${response.status}`)
  }
  return (await response.json()) as ProvisionResult
}
