import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedEntitlementManifest,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
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
let orgId = ''
let userBId = ''
let userCId = ''

function bearerFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  })
}

async function jsonOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

function createDm(token: string, otherUserId: string, key = randomUUID()): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/dms`, {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: JSON.stringify({ otherUserId })
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED dm vertical: Docker unavailable — ${String(error)}`)
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
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `dv-${orgId.slice(0, 8)}`,
    displayName: 'DV'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'a',
    roleIds: ['organization_owner']
  })
  userBId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'b',
      roleIds: ['member']
    })
  ).userId
  userCId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'c',
      roleIds: ['member']
    })
  ).userId
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat DM vertical', () => {
  it('find-or-create is idempotent (201 then 200, same channel)', async (ctx) => {
    if (!harness) return ctx.skip()
    const first = await createDm('a', userBId)
    expect(first.status).toBe(201)
    const created = await jsonOf<{ id: string; kind: string }>(first)
    expect(created.kind).toBe('dm')
    // b starts the same DM → 200, same channel.
    const second = await createDm(
      'b',
      (await jsonOf<{ userId: string }>(await bearerFetch('a', `/v1/session`))).userId
    )
    expect(second.status).toBe(200)
    expect((await jsonOf<{ id: string }>(second)).id).toBe(created.id)
  })

  it('both participants can message; a third user cannot read or see the DM', async (ctx) => {
    if (!harness) return ctx.skip()
    const dm = await jsonOf<{ id: string }>(await createDm('a', userBId))
    const post = await bearerFetch('a', `/v1/organizations/${orgId}/channels/${dm.id}/messages`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ body: 'private hi' })
    })
    expect(post.status).toBe(201)
    // b (participant) can read.
    const bList = await bearerFetch('b', `/v1/organizations/${orgId}/channels/${dm.id}/messages`)
    expect(bList.status).toBe(200)
    // c (not a participant) cannot read or post.
    expect(
      (await bearerFetch('c', `/v1/organizations/${orgId}/channels/${dm.id}/messages`)).status
    ).toBe(403)
    const cPost = await bearerFetch('c', `/v1/organizations/${orgId}/channels/${dm.id}/messages`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ body: 'let me in' })
    })
    expect(cPost.status).toBe(403)
    // c does not see the DM in their channel list.
    const cDms = await jsonOf<{ items: Array<{ id: string }> }>(
      await bearerFetch('c', `/v1/organizations/${orgId}/channels?kind=dm`)
    )
    expect(cDms.items.map((x) => x.id)).not.toContain(dm.id)
  })

  it('cannot DM a user outside the org (422)', async (ctx) => {
    if (!harness) return ctx.skip()
    const outsider = await createDm('a', randomUUID())
    expect(outsider.status).toBe(422)
  })

  it('moderation: adding a member is allowed on a normal channel but denied on a DM (409)', async (ctx) => {
    if (!harness) return ctx.skip()
    const channel = await jsonOf<{ id: string }>(
      await bearerFetch('a', `/v1/organizations/${orgId}/channels`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ name: 'team-room' })
      })
    )
    const addToChannel = await bearerFetch(
      'a',
      `/v1/organizations/${orgId}/channels/${channel.id}/members`,
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ userId: userCId })
      }
    )
    expect(addToChannel.status).toBe(204)
    const dm = await jsonOf<{ id: string }>(await createDm('a', userBId))
    const addToDm = await bearerFetch('a', `/v1/organizations/${orgId}/channels/${dm.id}/members`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ userId: userCId })
    })
    expect(addToDm.status).toBe(409)
  })

  it("lists the caller's DMs with ?kind=dm", async (ctx) => {
    if (!harness) return ctx.skip()
    await createDm('a', userBId)
    const dms = await jsonOf<{ items: Array<{ kind: string }> }>(
      await bearerFetch('a', `/v1/organizations/${orgId}/channels?kind=dm`)
    )
    expect(dms.items.length).toBeGreaterThanOrEqual(1)
    expect(dms.items.every((c) => c.kind === 'dm')).toBe(true)
  })
})
