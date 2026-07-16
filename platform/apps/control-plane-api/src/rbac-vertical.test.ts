import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  encodeCursor,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  updateOrganizationDisplayName,
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
import { createGatewayConnectionAuthorizer } from './gateway-connection-authorizer'
import { createRealtimeGateway, type RealtimeGateway } from './realtime-gateway'
import { createTestTokenVerifier, TEST_ISSUER } from './authorization-test-support'

const OPERATOR_TOKEN = 'operator-secret'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let gateway: RealtimeGateway
let app: FastifyInstance
let baseUrl = ''
let wsUrl = ''
let orgA = ''
let orgB = ''

const clock = { now: () => Date.now(), newId: () => randomUUID() }

async function seedOrg(): Promise<string> {
  const id = randomUUID()
  await seedOrganizationFixture(db, { id, slug: `rbac-${id.slice(0, 8)}`, displayName: 'RBAC Org' })
  return id
}

function authFetch(path: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED rbac vertical: Docker/PostgreSQL unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  registry = createContractSchemaRegistry()
  const verifier = createTestTokenVerifier()
  gateway = createRealtimeGateway({
    db,
    registry,
    listenConnectionString: harness.connectionString,
    heartbeatIntervalMs: 60_000,
    authorizeConnection: createGatewayConnectionAuthorizer(db, verifier)
  })
  app = buildApp({
    ping: async () => true,
    db,
    registry,
    gateway,
    tokenVerifier: verifier,
    operatorToken: OPERATOR_TOKEN
  })
  await app.ready()
  await gateway.start()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/v1/realtime`

  orgA = await seedOrg()
  orgB = await seedOrg()
  // Subjects: an owner of A, a guest of A (no organization.read), an owner of B.
  await seedMembershipFixture(db, { organizationId: orgA, issuer: TEST_ISSUER, subject: 'owner-a' })
  await seedMembershipFixture(db, {
    organizationId: orgA,
    issuer: TEST_ISSUER,
    subject: 'guest-a',
    roleIds: ['guest']
  })
  await seedMembershipFixture(db, { organizationId: orgB, issuer: TEST_ISSUER, subject: 'owner-b' })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('REST RBAC on /changes', () => {
  it('allows an authorized member', async (ctx) => {
    if (!harness) return ctx.skip()
    const response = await authFetch(
      `/v1/organizations/${orgA}/changes?after=${encodeCursor(0)}`,
      'owner-a'
    )
    expect(response.status).toBe(200)
  })

  it('rejects a missing token with 401', async (ctx) => {
    if (!harness) return ctx.skip()
    const response = await authFetch(`/v1/organizations/${orgA}/changes`)
    expect(response.status).toBe(401)
  })

  it('denies an insufficient role with 403 + a distinct reason in the security stream', async (ctx) => {
    if (!harness) return ctx.skip()
    const response = await authFetch(`/v1/organizations/${orgA}/changes`, 'guest-a')
    expect(response.status).toBe(403)
    const denial = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.authorization_denials')
        .select(['reason', 'permission'])
        .where('requested_organization_id', '=', orgA)
        .where('subject', '=', 'guest-a')
        .executeTakeFirst()
    )
    expect(denial?.reason).toBe('permission_denied')
    expect(denial?.permission).toBe('organization.read')
  })

  it('denies a cross-org request (member of B asking about A) with 403 + audit', async (ctx) => {
    if (!harness) return ctx.skip()
    const response = await authFetch(`/v1/organizations/${orgA}/changes`, 'owner-b')
    expect(response.status).toBe(403)
    const denial = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.authorization_denials')
        .select('reason')
        .where('requested_organization_id', '=', orgA)
        .where('subject', '=', 'owner-b')
        .executeTakeFirst()
    )
    expect(denial?.reason).toBe('no_active_membership')
  })

  it('denies a NON-EXISTENT org id with a clean 403 (never 500) + audit', async (ctx) => {
    if (!harness) return ctx.skip()
    const ghostOrg = '99999999-9999-4999-8999-999999999999'
    const response = await authFetch(`/v1/organizations/${ghostOrg}/changes`, 'owner-a')
    // The "다른 조직 ID를 직접 요청" attack: a request for an org that does not
    // exist must be a clean 403, not a 500 from an FK-violating audit insert.
    expect(response.status).toBe(403)
    const denial = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.authorization_denials')
        .select(['reason', 'requested_organization_id'])
        .where('requested_organization_id', '=', ghostOrg)
        .where('subject', '=', 'owner-a')
        .executeTakeFirst()
    )
    expect(denial?.reason).toBe('no_active_membership')
    expect(denial?.requested_organization_id).toBe(ghostOrg)
  })
})

describe('operator surface auth', () => {
  it('rejects /internal/metrics without the operator token, allows it with', async (ctx) => {
    if (!harness) return ctx.skip()
    expect((await authFetch('/internal/metrics')).status).toBe(401)
    expect((await authFetch('/internal/metrics', OPERATOR_TOKEN)).status).toBe(200)
  })
})

type WsResult = { welcomed: boolean; closed: boolean; changes: number }

async function openWs(
  orgId: string,
  token?: string
): Promise<{ result: WsResult; socket: WebSocket }> {
  const result: WsResult = { welcomed: false, closed: false, changes: 0 }
  const socket = new WebSocket(
    wsUrl,
    token ? { headers: { authorization: `Bearer ${token}` } } : {}
  )
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
  })
  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString()) as { type?: string }
    if (message.type === 'server.welcome') result.welcomed = true
    if (message.type === 'resource.changed') result.changes += 1
  })
  socket.on('close', () => {
    result.closed = true
  })
  socket.send(
    JSON.stringify({
      type: 'client.hello',
      schemaVersion: 1,
      protocolVersion: '1.0',
      instanceId: 'rbac-test',
      organizationId: orgId,
      lastCursor: null
    })
  )
  await delay(300)
  return { result, socket }
}

describe('Realtime WS RBAC', () => {
  it('subscribes an authorized member and delivers changes', async (ctx) => {
    if (!harness) return ctx.skip()
    const { result, socket } = await openWs(orgA, 'owner-a')
    expect(result.welcomed).toBe(true)
    await updateOrganizationDisplayName(db, clock, {
      organizationId: orgA,
      displayName: 'renamed-rbac'
    })
    await createOutboxClaimLoop({
      db,
      workerId: 'rbac-worker',
      batchSize: 10,
      leaseMs: 30_000,
      pollIntervalMs: 1000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0
    }).runOnce()
    for (let i = 0; i < 60 && result.changes === 0; i++) {
      await delay(50)
    }
    expect(result.changes).toBeGreaterThanOrEqual(1)
    socket.close()
  })

  it('rejects a subscriber with no membership in the org', async (ctx) => {
    if (!harness) return ctx.skip()
    // owner-b has no membership in orgA → connection rejected, never welcomed.
    const { result, socket } = await openWs(orgA, 'owner-b')
    expect(result.welcomed).toBe(false)
    socket.close()
  })

  it('rejects a subscriber with no token', async (ctx) => {
    if (!harness) return ctx.skip()
    const { result, socket } = await openWs(orgA)
    expect(result.welcomed).toBe(false)
    socket.close()
  })
})
