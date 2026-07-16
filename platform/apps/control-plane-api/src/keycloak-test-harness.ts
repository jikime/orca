import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

// The SAME realm file that deploy/compose/dev-keycloak.yml imports, so dev and
// test agree on the realm, the PUBLIC pie-desktop client, and PKCE S256.
const REALM_IMPORT_PATH = fileURLToPath(
  new URL('../../../../deploy/keycloak/pie-realm.json', import.meta.url)
)

const REALM = 'pie'
const DESKTOP_CLIENT_ID = 'pie-desktop'
const ADMIN_USER = 'admin'
const ADMIN_PASSWORD = 'admin'

export type TestUserToken = {
  accessToken: string
  // The Keycloak user id, which is the token's `sub`.
  subject: string
}

export type KeycloakHarness = {
  issuer: string
  jwksUri: string
  audience: string
  // Creates a realm user and returns a REAL access token via the direct-access
  // (password) grant. TEST ONLY — production uses system-browser PKCE, never a
  // password grant. emailVerified toggles the email_verified token claim.
  createUserToken: (input: { email: string; emailVerified: boolean }) => Promise<TestUserToken>
  stop: () => Promise<void>
}

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  })
}

/**
 * Starts an ephemeral Keycloak with the Pie realm imported (start-dev). Throws if
 * Docker is unavailable — callers skip gracefully with an explicit reason. The
 * image pull on a cold cache can take a minute; the startup timeout allows for it.
 */
export async function startKeycloakHarness(): Promise<KeycloakHarness> {
  const container: StartedTestContainer = await new GenericContainer(
    'quay.io/keycloak/keycloak:26.0'
  )
    .withCommand(['start-dev', '--import-realm'])
    .withCopyFilesToContainer([
      { source: REALM_IMPORT_PATH, target: '/opt/keycloak/data/import/pie-realm.json' }
    ])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: ADMIN_USER,
      KC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
      KC_HTTP_ENABLED: 'true',
      KC_HEALTH_ENABLED: 'true'
    })
    .withExposedPorts(8080)
    .withWaitStrategy(
      Wait.forHttp(`/realms/${REALM}/.well-known/openid-configuration`, 8080).forStatusCode(200)
    )
    .withStartupTimeout(240_000)
    .start()

  const base = `http://${container.getHost()}:${container.getMappedPort(8080)}`
  const issuer = `${base}/realms/${REALM}`

  const adminToken = async (): Promise<string> => {
    const response = await postForm(`${base}/realms/master/protocol/openid-connect/token`, {
      client_id: 'admin-cli',
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
      grant_type: 'password'
    })
    const body = (await response.json()) as { access_token: string }
    return body.access_token
  }

  const createUserToken: KeycloakHarness['createUserToken'] = async ({ email, emailVerified }) => {
    const token = await adminToken()
    const password = 'Test-Passw0rd!'
    // requiredActions:[] so the direct-access grant is not blocked by a pending
    // action ("Account is not fully set up") — the realm's verifyEmail flow would
    // otherwise attach one even for an admin-created account.
    const created = await fetch(`${base}/admin/realms/${REALM}/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: email,
        email,
        // firstName/lastName so the declarative user profile is complete —
        // Keycloak 26's VERIFY_PROFILE default action otherwise blocks login with
        // "Account is not fully set up".
        firstName: 'Test',
        lastName: 'User',
        emailVerified,
        enabled: true,
        requiredActions: []
      })
    })
    if (created.status !== 201) {
      throw new Error(`keycloak user create failed: ${created.status} ${await created.text()}`)
    }
    const subject = created.headers.get('location')?.split('/').pop() ?? ''

    // Set the password via reset-password (more reliable than inline credentials).
    const reset = await fetch(`${base}/admin/realms/${REALM}/users/${subject}/reset-password`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'password', value: password, temporary: false })
    })
    if (reset.status !== 204) {
      throw new Error(`keycloak set-password failed: ${reset.status} ${await reset.text()}`)
    }

    const grant = await postForm(`${issuer}/protocol/openid-connect/token`, {
      client_id: DESKTOP_CLIENT_ID,
      grant_type: 'password',
      username: email,
      password,
      scope: 'openid email'
    })
    if (!grant.ok) {
      throw new Error(`keycloak token grant failed: ${grant.status} ${await grant.text()}`)
    }
    const grantBody = (await grant.json()) as { access_token: string }
    return { accessToken: grantBody.access_token, subject }
  }

  return {
    issuer,
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
    audience: DESKTOP_CLIENT_ID,
    createUserToken,
    stop: async () => {
      await container.stop()
    }
  }
}
