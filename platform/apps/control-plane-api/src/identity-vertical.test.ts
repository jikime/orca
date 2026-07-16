import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  loadRoleManifestCatalog,
  runMigrations,
  seedRoleManifest,
  withTenantTransaction,
  withoutTenantContext,
  type PieDatabase
} from '@pie/persistence'
import { createOutboxClaimLoop } from '@pie/control-plane-worker/outbox-claim-loop'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import {
  createContractSchemaRegistry,
  type ContractSchemaRegistry
} from './contract-schema-registry'
import { createKeycloakTokenVerifier } from './keycloak-token-verifier'
import { createGatewayConnectionAuthorizer } from './gateway-connection-authorizer'
import { createRealtimeGateway, type RealtimeGateway } from './realtime-gateway'
import { startKeycloakHarness, type KeycloakHarness } from './keycloak-test-harness'

let pg: PostgresHarness | null = null
let kc: KeycloakHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let gateway: RealtimeGateway
let app: FastifyInstance
let baseUrl = ''
let wsUrl = ''

const catalog = loadRoleManifestCatalog()

type ProvisionBody = {
  organizationId: string
  userId: string
  membershipId: string
  created: boolean
}
type SessionBody = {
  status: string
  instanceId: string
  userId?: string
  organizationId?: string
  permissions?: string[]
}

async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function newVerifiedToken(): Promise<{ token: string; subject: string; email: string }> {
  const email = `user-${randomUUID().slice(0, 8)}@test.pielab.ai`
  const { accessToken, subject } = await kc!.createUserToken({ email, emailVerified: true })
  return { token: accessToken, subject, email }
}

function authFetch(path: string, token?: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  if (init.body) {
    headers['content-type'] = 'application/json'
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers })
}

async function provision(token: string, name?: string): Promise<Response> {
  return authFetch('/v1/provisioning', token, {
    method: 'POST',
    body: JSON.stringify(name ? { organizationDisplayName: name } : {})
  })
}

beforeAll(async () => {
  try {
    pg = await startPostgresHarness()
    kc = await startKeycloakHarness()
  } catch (error) {
    console.warn(`SKIPPED identity vertical: Docker/Keycloak unavailable — ${String(error)}`)
    await pg?.stop()
    await kc?.stop()
    pg = null
    kc = null
    return
  }
  pool = createDatabasePool({ connectionString: pg.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  registry = createContractSchemaRegistry()
  const verifier = createKeycloakTokenVerifier({
    issuer: kc.issuer,
    audience: kc.audience,
    jwksUri: kc.jwksUri
  })
  gateway = createRealtimeGateway({
    db,
    registry,
    listenConnectionString: pg.connectionString,
    heartbeatIntervalMs: 60_000,
    // Real WS auth: the subscriber's bearer token + membership are verified.
    authorizeConnection: createGatewayConnectionAuthorizer(db, verifier)
  })
  app = buildApp({
    ping: async () => true,
    db,
    registry,
    gateway,
    tokenVerifier: verifier,
    discoveryConfig: {
      instanceId: 'pie-test',
      displayName: 'Pie test',
      deploymentType: 'local_docker',
      apiBaseUrl: 'http://127.0.0.1/v1',
      issuer: kc.issuer,
      clientId: 'pie-desktop',
      realtimeUrl: 'ws://127.0.0.1/v1/realtime',
      minimumClientVersion: '0.1.0',
      ttlSeconds: 300
    }
  })
  await app.ready()
  await gateway.start()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/v1/realtime`
}, 300_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await pg?.stop()
  await kc?.stop()
})

describe('token verification (real Keycloak)', () => {
  it('accepts a real token and rejects a tampered one', async (ctx) => {
    if (!pg || !kc) return ctx.skip()
    const { token } = await newVerifiedToken()
    // Accepted: /v1/session returns signed_out (verified but not provisioned).
    const ok = await authFetch('/v1/session', token)
    expect(ok.status).toBe(200)
    expect((await jsonBody<SessionBody>(ok)).status).toBe('signed_out')

    const tampered = `${token.slice(0, -4)}zzzz`
    const bad = await authFetch('/v1/provisioning', tampered, { method: 'POST', body: '{}' })
    expect(bad.status).toBe(401)
  })
})

describe('session state', () => {
  it('is signed_out with no token', async (ctx) => {
    if (!pg || !kc) return ctx.skip()
    const response = await authFetch('/v1/session')
    expect(response.status).toBe(200)
    const body = await jsonBody<SessionBody>(response)
    expect(body).toEqual({ status: 'signed_out', instanceId: 'pie-test' })
  })

  it('is signed_out for a verified token with no membership', async (ctx) => {
    if (!pg || !kc) return ctx.skip()
    const { token } = await newVerifiedToken()
    const body = await jsonBody<SessionBody>(await authFetch('/v1/session', token))
    expect(body.status).toBe('signed_out')
  })

  it('is signed_in with owner permissions after provisioning', async (ctx) => {
    if (!pg || !kc) return ctx.skip()
    const { token } = await newVerifiedToken()
    const provisioned = await jsonBody<ProvisionBody>(await provision(token, 'Acme'))
    const body = await jsonBody<SessionBody>(await authFetch('/v1/session', token))
    expect(body.status).toBe('signed_in')
    expect(body.organizationId).toBe(provisioned.organizationId)
    expect(body.userId).toBe(provisioned.userId)
    expect(body.permissions).toEqual(catalog.permissionsForRoles(['organization_owner']))
    expect(body).not.toHaveProperty('accessToken')
  })
})

describe('provisioning', () => {
  it('creates account + org + owner membership + audit + outbox in one transaction', async (ctx) => {
    if (!pg || !kc) return ctx.skip()
    const { token, subject } = await newVerifiedToken()
    const result = await jsonBody<ProvisionBody>(await provision(token))
    expect(result.created).toBe(true)

    const rows = await withoutTenantContext(db, async (trx) => {
      const account = await trx
        .selectFrom('identity.user_accounts')
        .select('id')
        .where('subject', '=', subject)
        .executeTakeFirst()
      const org = await trx
        .selectFrom('identity.organizations')
        .select('id')
        .where('id', '=', result.organizationId)
        .executeTakeFirst()
      const membership = await trx
        .selectFrom('identity.memberships')
        .select('role_ids')
        .where('organization_id', '=', result.organizationId)
        .executeTakeFirst()
      const audit = await trx
        .selectFrom('audit.audit_events')
        .select('id')
        .where('organization_id', '=', result.organizationId)
        .where('action', '=', 'organization.provisioned')
        .executeTakeFirst()
      const outbox = await trx
        .selectFrom('operations.outbox_events')
        .select('event_type')
        .where('organization_id', '=', result.organizationId)
        .executeTakeFirst()
      return { account, org, membership, audit, outbox }
    })
    expect(rows.account).toBeDefined()
    expect(rows.org).toBeDefined()
    expect(rows.membership?.role_ids).toEqual(['organization_owner'])
    expect(rows.audit).toBeDefined()
    expect(rows.outbox?.event_type).toContain('organization.created')
  })

  it('is idempotent on the same subject (same org, no duplicates)', async (ctx) => {
    if (!pg || !kc) return ctx.skip()
    const { token } = await newVerifiedToken()
    const first = await jsonBody<ProvisionBody>(await provision(token))
    const second = await provision(token)
    expect(second.status).toBe(200)
    const secondBody = await jsonBody<ProvisionBody>(second)
    expect(secondBody.created).toBe(false)
    expect(secondBody.organizationId).toBe(first.organizationId)
  })

  it('delivers the organization.created outbox event to a realtime subscriber', async (ctx) => {
    if (!pg || !kc) return ctx.skip()
    const { token } = await newVerifiedToken()
    const org = await jsonBody<ProvisionBody>(await provision(token))

    const changes: unknown[] = []
    // The WS upgrade carries the provisioned user's bearer; the gateway verifies
    // the token and their membership in the org before subscribing.
    const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
    })
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as { type?: string }
      if (message.type === 'resource.changed') changes.push(message)
    })
    socket.send(
      JSON.stringify({
        type: 'client.hello',
        schemaVersion: 1,
        protocolVersion: '1.0',
        instanceId: 'prov-test',
        organizationId: org.organizationId,
        lastCursor: null
      })
    )
    await delay(200)
    // Publish the pending provisioning event now that the subscriber is live.
    await createOutboxClaimLoop({
      db,
      workerId: 'prov-worker',
      batchSize: 10,
      leaseMs: 30_000,
      pollIntervalMs: 1000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0
    }).runOnce()
    for (let i = 0; i < 60 && changes.length === 0; i++) {
      await delay(50)
    }
    expect(changes.length).toBeGreaterThanOrEqual(1)
    socket.close()
  })
})

describe('memberships and tenant isolation', () => {
  it('lists memberships for a member and denies a non-member (403)', async (ctx) => {
    if (!pg || !kc) return ctx.skip()
    const a = await newVerifiedToken()
    const b = await newVerifiedToken()
    const orgA = (await jsonBody<ProvisionBody>(await provision(a.token))).organizationId
    const orgB = (await jsonBody<ProvisionBody>(await provision(b.token))).organizationId

    const own = await authFetch(`/v1/organizations/${orgA}/memberships`, a.token)
    expect(own.status).toBe(200)
    const items = (await jsonBody<{ items: { roleIds: string[] }[] }>(own)).items
    expect(items.length).toBe(1)
    // roleIds are all valid manifest vocabulary.
    expect(items[0]!.roleIds.every((role) => catalog.hasRole(role))).toBe(true)

    const cross = await authFetch(`/v1/organizations/${orgB}/memberships`, a.token)
    expect(cross.status).toBe(403)
  })

  it('blocks cross-tenant user enumeration under RLS', async (ctx) => {
    if (!pg || !kc) return ctx.skip()
    const a = await newVerifiedToken()
    const b = await newVerifiedToken()
    const orgA = (await jsonBody<ProvisionBody>(await provision(a.token))).organizationId
    const provB = await jsonBody<ProvisionBody>(await provision(b.token))

    // In org A's tenant context, user B's account row is invisible (not a co-member);
    // user A's own row is visible.
    const seen = await withTenantTransaction(db, orgA, (trx) =>
      trx.selectFrom('identity.user_accounts').select('id').execute()
    )
    const ids = seen.map((row) => row.id)
    expect(ids).not.toContain(provB.userId)
  })
})
