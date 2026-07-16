import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'

// Test harness: a plain-node mock OIDC provider (discovery + token + JWKS) and a
// mock Control Plane (instance discovery + session + provisioning), so the login
// vertical runs end to end without Keycloak. Loopback HTTP throughout — the
// service is configured with allowLoopbackHttp for the dev exception.

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

export type RsaTestKey = {
  privateKey: KeyObject
  jwk: Record<string, unknown>
}

export function createRsaTestKey(kid = 'test-key'): RsaTestKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' }
  return { privateKey, jwk: jwk as Record<string, unknown> }
}

export function signRs256Jwt(
  payload: Record<string, unknown>,
  key: RsaTestKey,
  kid = 'test-key'
): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signingInput = `${header}.${body}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.privateKey)
  return `${signingInput}.${signature.toString('base64url')}`
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function readJsonBody(chunks: Buffer[]): URLSearchParams {
  return new URLSearchParams(Buffer.concat(chunks).toString('utf-8'))
}

export type MockOidcProvider = {
  issuer: string
  key: RsaTestKey
  registerAuthCode: (
    code: string,
    claims: { sub: string; email: string; emailVerified: boolean; nonce: string }
  ) => void
  failNextRefresh: () => void
  stop: () => Promise<void>
}

export async function startMockOidcProvider(clientId: string): Promise<MockOidcProvider> {
  const key = createRsaTestKey()
  const codes = new Map<
    string,
    { sub: string; email: string; emailVerified: boolean; nonce: string }
  >()
  let refreshCounter = 0
  let failRefresh = false
  let issuer = ''

  const signIdToken = (claims: {
    sub: string
    email: string
    emailVerified: boolean
    nonce: string
  }): string =>
    signRs256Jwt(
      {
        iss: issuer,
        aud: clientId,
        sub: claims.sub,
        email: claims.email,
        email_verified: claims.emailVerified,
        name: 'Test User',
        nonce: claims.nonce,
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000)
      },
      key
    )

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', issuer)
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (url.pathname === '/realms/pie/.well-known/openid-configuration') {
      send(200, {
        issuer,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
        end_session_endpoint: `${issuer}/protocol/openid-connect/logout`
      })
      return
    }
    if (url.pathname === '/realms/pie/protocol/openid-connect/certs') {
      send(200, { keys: [key.jwk] })
      return
    }
    if (url.pathname === '/realms/pie/protocol/openid-connect/token' && request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const form = readJsonBody(chunks)
        if (form.get('grant_type') === 'authorization_code') {
          const claims = codes.get(form.get('code') ?? '')
          if (!claims) {
            send(400, { error: 'invalid_grant' })
            return
          }
          send(200, {
            access_token: `access-${randomUUID()}`,
            refresh_token: `refresh-${randomUUID()}`,
            id_token: signIdToken(claims),
            expires_in: 300,
            token_type: 'Bearer'
          })
          return
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (failRefresh) {
            send(400, { error: 'invalid_grant', error_description: 'refresh revoked' })
            return
          }
          refreshCounter += 1
          send(200, {
            access_token: `access-rotated-${refreshCounter}`,
            refresh_token: `refresh-rotated-${refreshCounter}`,
            expires_in: 300,
            token_type: 'Bearer'
          })
          return
        }
        send(400, { error: 'unsupported_grant_type' })
      })
      return
    }
    if (
      url.pathname === '/realms/pie/protocol/openid-connect/logout' &&
      request.method === 'POST'
    ) {
      send(204, {})
      return
    }
    send(404, { error: 'not_found' })
  })

  const port = await listen(server)
  issuer = `http://127.0.0.1:${port}/realms/pie`
  return {
    issuer,
    key,
    registerAuthCode: (code, claims) => codes.set(code, claims),
    failNextRefresh: () => {
      failRefresh = true
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

export type MockControlPlane = {
  baseUrl: string
  apiBaseUrl: string
  discoveryUrl: string
  stop: () => Promise<void>
}

/**
 * Mock Control Plane: serves the instance discovery document (pointing at the
 * given OIDC issuer), a session endpoint (signed_out until provisioned), and a
 * provisioning endpoint that flips the caller to signed_in.
 */
export async function startMockControlPlane(input: {
  issuer: string
  clientId: string
  redirectModes: ('loopback' | 'private_uri_scheme')[]
}): Promise<MockControlPlane> {
  const organizationId = randomUUID()
  const userId = randomUUID()
  let provisioned = false
  let baseUrl = ''

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', baseUrl)
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/pie') {
      send(200, {
        schemaVersion: 1,
        instanceId: 'pie-test',
        displayName: 'Pie test',
        deploymentType: 'local_docker',
        apiBaseUrl: `${baseUrl}/v1`,
        auth: {
          protocol: 'oidc',
          issuer: input.issuer,
          clientId: input.clientId,
          redirectModes: input.redirectModes
        },
        realtimeUrl: `ws://127.0.0.1:${new URL(baseUrl).port}/v1/realtime`,
        protocol: { api: '1.0', realtime: '1.0' },
        minimumClientVersion: '0.1.0',
        capabilities: { organizationRead: true },
        expiresAt: new Date(Date.now() + 300_000).toISOString()
      })
      return
    }
    if (url.pathname === '/v1/session') {
      if (!provisioned) {
        send(200, { status: 'signed_out', instanceId: 'pie-test' })
        return
      }
      send(200, {
        status: 'signed_in',
        instanceId: 'pie-test',
        userId,
        displayName: 'Test User',
        organizationId,
        permissions: ['organization.read', 'member.read'],
        expiresAt: new Date(Date.now() + 300_000).toISOString()
      })
      return
    }
    if (url.pathname === '/v1/provisioning' && request.method === 'POST') {
      provisioned = true
      send(201, { organizationId, userId, created: true })
      return
    }
    send(404, { error: 'not_found' })
  })

  const port = await listen(server)
  baseUrl = `http://127.0.0.1:${port}`
  return {
    baseUrl,
    apiBaseUrl: `${baseUrl}/v1`,
    discoveryUrl: `${baseUrl}/.well-known/pie`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
