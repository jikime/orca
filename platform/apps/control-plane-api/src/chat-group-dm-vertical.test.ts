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
let userAId = ''

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

function createGroupDm(
  token: string,
  participantUserIds: string[],
  key = randomUUID()
): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/group-dms`, {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: JSON.stringify({ participantUserIds })
  })
}

function createDm(token: string, otherUserId: string, key = randomUUID()): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/dms`, {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: JSON.stringify({ otherUserId })
  })
}

// A fresh org member per call, so each test forms a NOVEL participant set (novel dm_key)
// and its first create is a clean 201 despite the shared org. The token IS the subject.
async function seedMember(tag: string): Promise<{ userId: string; token: string }> {
  const token = `${tag}-${randomUUID().slice(0, 8)}`
  const { userId } = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: token,
    roleIds: ['member']
  })
  return { userId, token }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED group dm vertical: Docker unavailable — ${String(error)}`)
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
    slug: `gdv-${orgId.slice(0, 8)}`,
    displayName: 'GDV'
  })
  userAId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'a',
      roleIds: ['organization_owner']
    })
  ).userId
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat group DM vertical', () => {
  it('creates a 3-party group DM; all three are members with kind=dm', async (ctx) => {
    if (!harness) return ctx.skip()
    const p1 = await seedMember('m1')
    const p2 = await seedMember('m2')
    const res = await createGroupDm('a', [p1.userId, p2.userId])
    expect(res.status).toBe(201)
    const group = await jsonOf<{ id: string; kind: string }>(res)
    expect(group.kind).toBe('dm')
    // Caller A and both participants all see the group in their DM list.
    for (const token of ['a', p1.token, p2.token]) {
      const dms = await jsonOf<{ items: Array<{ id: string }> }>(
        await bearerFetch(token, `/v1/organizations/${orgId}/channels?kind=dm`)
      )
      expect(dms.items.map((x) => x.id)).toContain(group.id)
    }
  })

  it('is idempotent for the same set in any order, with or without the caller listed', async (ctx) => {
    if (!harness) return ctx.skip()
    const p1 = await seedMember('i1')
    const p2 = await seedMember('i2')
    const first = await createGroupDm('a', [p1.userId, p2.userId])
    expect(first.status).toBe(201)
    const group = await jsonOf<{ id: string }>(first)
    // Reordered participants → 200, same channel.
    const reordered = await createGroupDm('a', [p2.userId, p1.userId])
    expect(reordered.status).toBe(200)
    expect((await jsonOf<{ id: string }>(reordered)).id).toBe(group.id)
    // Caller lists themselves explicitly → still the same distinct set → 200, same channel.
    const withSelf = await createGroupDm('a', [userAId, p1.userId, p2.userId])
    expect(withSelf.status).toBe(200)
    expect((await jsonOf<{ id: string }>(withSelf)).id).toBe(group.id)
    // A participant opening the same set → 200, same channel.
    const fromP1 = await createGroupDm(p1.token, [userAId, p2.userId])
    expect(fromP1.status).toBe(200)
    expect((await jsonOf<{ id: string }>(fromP1)).id).toBe(group.id)
  })

  it('a 3-party group {A,B,C} is a DIFFERENT channel than the 1:1 {A,B}', async (ctx) => {
    if (!harness) return ctx.skip()
    const p1 = await seedMember('d1')
    const p2 = await seedMember('d2')
    const group = await jsonOf<{ id: string }>(await createGroupDm('a', [p1.userId, p2.userId]))
    const oneToOne = await jsonOf<{ id: string }>(await createDm('a', p1.userId))
    expect(group.id).not.toBe(oneToOne.id)
  })

  it('rejects a participant who is not an org member (422)', async (ctx) => {
    if (!harness) return ctx.skip()
    const p1 = await seedMember('t1')
    const res = await createGroupDm('a', [p1.userId, randomUUID()])
    expect(res.status).toBe(422)
  })

  it('rejects fewer than 3 distinct participants (400)', async (ctx) => {
    if (!harness) return ctx.skip()
    // Only the caller + one other = a 1:1 DM, which /group-dms rejects.
    const p1 = await seedMember('f1')
    const res = await createGroupDm('a', [p1.userId])
    expect(res.status).toBe(400)
  })

  it('roster is immutable: adding a member to a group DM is rejected (409)', async (ctx) => {
    if (!harness) return ctx.skip()
    const p1 = await seedMember('r1')
    const p2 = await seedMember('r2')
    const group = await jsonOf<{ id: string }>(await createGroupDm('a', [p1.userId, p2.userId]))
    const outsider = await seedMember('r3')
    const add = await bearerFetch('a', `/v1/organizations/${orgId}/channels/${group.id}/members`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ userId: outsider.userId })
    })
    expect(add.status).toBe(409)
  })
})
