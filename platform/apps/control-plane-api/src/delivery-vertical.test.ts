import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  createResourceGrant,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedSubscriptionFixture,
  seedEntitlementManifest,
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

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let gateway: RealtimeGateway
let app: FastifyInstance
let baseUrl = ''
let wsUrl = ''
let orgId = ''
let ownerId = ''

function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer owner',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  })
}

async function jsonOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED delivery vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  const verifier = createTestTokenVerifier()
  gateway = createRealtimeGateway({
    db,
    registry,
    listenConnectionString: harness.connectionString,
    heartbeatIntervalMs: 60_000,
    authorizeConnection: createGatewayConnectionAuthorizer(db, verifier)
  })
  app = buildApp({ ping: async () => true, db, registry, gateway, tokenVerifier: verifier })
  await app.ready()
  await gateway.start()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/v1/realtime`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `dv-${orgId.slice(0, 8)}`,
    displayName: 'DV'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  // Give the org a team to own projects.
  await authFetch(`/v1/organizations/${orgId}/teams`, {
    method: 'POST',
    body: JSON.stringify({ key: 'CORE', name: 'Core' })
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('Team + Project vertical', () => {
  it('creates a team and rejects a duplicate key (409)', async (ctx) => {
    if (!harness) return ctx.skip()
    const dup = await authFetch(`/v1/organizations/${orgId}/teams`, {
      method: 'POST',
      body: JSON.stringify({ key: 'CORE', name: 'Dup' })
    })
    expect(dup.status).toBe(409)
  })

  it('creates a project and delivers project.created to a realtime subscriber', async (ctx) => {
    if (!harness) return ctx.skip()
    const changes: unknown[] = []
    const socket = new WebSocket(wsUrl, { headers: { authorization: 'Bearer owner' } })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
    })
    socket.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString()) as { type?: string }
      if (m.type === 'resource.changed') changes.push(m)
    })
    socket.send(
      JSON.stringify({
        type: 'client.hello',
        schemaVersion: 1,
        protocolVersion: '1.0',
        instanceId: 'dv-test',
        organizationId: orgId,
        lastCursor: null
      })
    )
    await delay(250)
    const create = await authFetch(`/v1/organizations/${orgId}/projects`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'Apollo' })
    })
    expect(create.status).toBe(201)
    expect(create.headers.get('etag')).toBe('"project-1"')
    await createOutboxClaimLoop({
      db,
      workerId: 'dv-w',
      batchSize: 10,
      leaseMs: 30_000,
      pollIntervalMs: 1000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0
    }).runOnce()
    for (let i = 0; i < 60 && changes.length === 0; i++) await delay(50)
    expect(changes.length).toBeGreaterThanOrEqual(1)
    socket.close()
  })

  it('updates under If-Match and returns 412 on a stale ETag', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await jsonOf<{ id: string }>(
      await authFetch(`/v1/organizations/${orgId}/projects`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ name: 'Edit' })
      })
    )
    const ok = await authFetch(`/v1/organizations/${orgId}/projects/${created.id}`, {
      method: 'PATCH',
      headers: { 'if-match': '"project-1"', 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ name: 'Edited' })
    })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('etag')).toBe('"project-2"')
    const stale = await authFetch(`/v1/organizations/${orgId}/projects/${created.id}`, {
      method: 'PATCH',
      headers: { 'if-match': '"project-1"', 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ name: 'Again' })
    })
    expect(stale.status).toBe(412)
  })

  it('a per-project NARROW grant denies getProject even though the role grants project.read', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await jsonOf<{ id: string }>(
      await authFetch(`/v1/organizations/${orgId}/projects`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ name: 'Secret' })
      })
    )
    // The role (owner) grants project.read org-wide; a narrow grant removes it on
    // THIS project — the ResourceGrant evaluator's first real production consumer.
    await createResourceGrant(db, {
      organizationId: orgId,
      userId: ownerId,
      resourceType: 'project',
      resourceId: created.id,
      grantKind: 'narrow',
      permission: 'project.read'
    })
    const denied = await authFetch(`/v1/organizations/${orgId}/projects/${created.id}`)
    expect(denied.status).toBe(403)
    const audit = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.authorization_denials')
        .select('reason')
        .where('subject', '=', 'owner')
        .where('reason', '=', 'resource_narrowed')
        .executeTakeFirst()
    )
    expect(audit?.reason).toBe('resource_narrowed')
  })

  it('blocks a project create over the core.projects limit with 402', async (ctx) => {
    if (!harness) return ctx.skip()
    const limitedOrg = randomUUID()
    await seedOrganizationFixture(db, {
      id: limitedOrg,
      slug: `lim-${limitedOrg.slice(0, 8)}`,
      displayName: 'Lim'
    })
    await seedMembershipFixture(db, {
      organizationId: limitedOrg,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
    await seedSubscriptionFixture(db, { organizationId: limitedOrg, planId: 'personal' })
    await withoutTenantContext(db, async (trx) => {
      for (let i = 0; i < 10; i++)
        await trx
          .insertInto('delivery.projects')
          .values({ organization_id: limitedOrg, name: `P${i}` })
          .execute()
    })
    // Needs a team to own the project.
    await authFetch(`/v1/organizations/${limitedOrg}/teams`, {
      method: 'POST',
      body: JSON.stringify({ key: 'CORE', name: 'C' })
    })
    const over = await authFetch(`/v1/organizations/${limitedOrg}/projects`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'Over' })
    })
    expect(over.status).toBe(402)
  })
})
