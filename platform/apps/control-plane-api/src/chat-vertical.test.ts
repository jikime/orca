import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  addChannelMember,
  createDatabase,
  createDatabasePool,
  getReadCursor,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedEntitlementManifest,
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
let member2Id = ''
let channelId = ''

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

function postMessageAs(token: string, key: string, body: string): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: JSON.stringify({ body })
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED chat vertical: Docker unavailable — ${String(error)}`)
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
    slug: `cv-${orgId.slice(0, 8)}`,
    displayName: 'CV'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  member2Id = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'member2',
      roleIds: ['member']
    })
  ).userId
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'stranger',
    roleIds: ['member']
  })
  const channel = await jsonOf<{ id: string }>(
    await bearerFetch('owner', `/v1/organizations/${orgId}/channels`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'general' })
    })
  )
  channelId = channel.id
  // member2 joins the channel (a join endpoint is a later increment; slice 1 seeds
  // the second member directly through the roster store).
  await addChannelMember(db, { organizationId: orgId, channelId, userId: member2Id })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat vertical', () => {
  it('lists the channel for its members', async (ctx) => {
    if (!harness) return ctx.skip()
    const owned = await jsonOf<{ items: Array<{ id: string }> }>(
      await bearerFetch('owner', `/v1/organizations/${orgId}/channels`)
    )
    expect(owned.items.map((c) => c.id)).toContain(channelId)
  })

  it('a member posts and the invalidation reaches another member over realtime', async (ctx) => {
    if (!harness) return ctx.skip()
    const changes: Array<{ resourceType?: string }> = []
    const socket = new WebSocket(wsUrl, { headers: { authorization: 'Bearer member2' } })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
    })
    socket.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString()) as { type?: string; resourceType?: string }
      if (m.type === 'resource.changed') changes.push(m)
    })
    socket.send(
      JSON.stringify({
        type: 'client.hello',
        schemaVersion: 1,
        protocolVersion: '1.0',
        instanceId: 'cv-test',
        organizationId: orgId,
        lastCursor: null
      })
    )
    await delay(250)
    const posted = await postMessageAs('owner', randomUUID(), 'hello channel')
    expect(posted.status).toBe(201)
    expect(posted.headers.get('location')).toContain('/messages/')
    await createOutboxClaimLoop({
      db,
      workerId: 'cv-w',
      batchSize: 10,
      leaseMs: 30_000,
      pollIntervalMs: 1000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0
    }).runOnce()
    for (let i = 0; i < 60 && !changes.some((c) => c.resourceType === 'message'); i++)
      await delay(50)
    expect(changes.some((c) => c.resourceType === 'message')).toBe(true)
    socket.close()
    const list = await jsonOf<{ items: Array<{ body: string }> }>(
      await bearerFetch('member2', `/v1/organizations/${orgId}/channels/${channelId}/messages`)
    )
    expect(list.items.some((m) => m.body === 'hello channel')).toBe(true)
  })

  it('a non-member cannot post or list (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const post = await postMessageAs('stranger', randomUUID(), 'let me in')
    expect(post.status).toBe(403)
    const list = await bearerFetch(
      'stranger',
      `/v1/organizations/${orgId}/channels/${channelId}/messages`
    )
    expect(list.status).toBe(403)
  })

  it('dedups a duplicate postMessage with the same idempotency key', async (ctx) => {
    if (!harness) return ctx.skip()
    const key = randomUUID()
    const before = await jsonOf<{ items: unknown[] }>(
      await bearerFetch('owner', `/v1/organizations/${orgId}/channels/${channelId}/messages`)
    )
    const a = await jsonOf<{ id: string }>(await postMessageAs('owner', key, 'idempotent post'))
    const b = await jsonOf<{ id: string }>(await postMessageAs('owner', key, 'idempotent post'))
    expect(b.id).toBe(a.id)
    const after = await jsonOf<{ items: unknown[] }>(
      await bearerFetch('owner', `/v1/organizations/${orgId}/channels/${channelId}/messages`)
    )
    expect(after.items.length).toBe(before.items.length + 1)
  })

  it("marks the caller's own read cursor and leaves others independent", async (ctx) => {
    if (!harness) return ctx.skip()
    const msg = await jsonOf<{ id: string }>(await postMessageAs('owner', randomUUID(), 'read me'))
    const marked = await bearerFetch(
      'member2',
      `/v1/organizations/${orgId}/channels/${channelId}/read`,
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ lastReadMessageId: msg.id })
      }
    )
    expect(marked.status).toBe(200)
    const cursor = await jsonOf<{ userId: string; lastReadMessageId: string }>(marked)
    expect(cursor.userId).toBe(member2Id)
    expect(cursor.lastReadMessageId).toBe(msg.id)
    // The owner's own cursor is untouched by member2's mark.
    const ownerId = (await jsonOf<{ userId: string }>(await bearerFetch('owner', `/v1/session`)))
      .userId
    expect(await getReadCursor(db, orgId, channelId, ownerId)).toBe(null)
  })
})
