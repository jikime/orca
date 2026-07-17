import { randomUUID } from 'node:crypto'

// R5 s2b trust bootstrap: registers the per-installation Ed25519 PUBLIC key with the Control Plane
// (POST /v1/organizations/:org/installation-keys) so signed ExecutionContexts can be verified. The
// PRIVATE key never leaves the signer; only the PEM public key and the derived id are sent. The
// access token is a bearer that NEVER appears in a log/error line here, and an idempotency-key makes
// a retried registration safe (the server replays the prior outcome). apiBaseUrl already includes /v1.

export class InstallationKeyRegistrationError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'InstallationKeyRegistrationError'
    this.status = status
  }
}

export type InstallationKeyRegistrationDeps = {
  getApiBaseUrl: () => string | null
  getAccessToken: () => string | null
  fetchImpl?: typeof fetch
  newId?: () => string
}

export type RegisterInstallationKeyParams = {
  organizationId: string
  installationId: string
  publicKeyPem: string
}

export async function registerInstallationKey(
  deps: InstallationKeyRegistrationDeps,
  params: RegisterInstallationKeyParams
): Promise<void> {
  const apiBaseUrl = deps.getApiBaseUrl()
  const accessToken = deps.getAccessToken()
  if (!apiBaseUrl || !accessToken) {
    // Signed out / no base URL: refuse to build an unauthenticated request.
    throw new InstallationKeyRegistrationError(
      'not authenticated for installation-key registration'
    )
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  const newId = deps.newId ?? randomUUID
  const response = await fetchImpl(
    `${apiBaseUrl}/organizations/${params.organizationId}/installation-keys`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': newId()
      },
      body: JSON.stringify({
        installationId: params.installationId,
        publicKey: params.publicKeyPem,
        algorithm: 'ed25519'
      })
    }
  )
  if (!response.ok) {
    throw new InstallationKeyRegistrationError(
      `installation-key registration failed with ${response.status}`,
      response.status
    )
  }
}
