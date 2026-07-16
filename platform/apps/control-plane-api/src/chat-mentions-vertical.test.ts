import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  addChannelMember,
  createDatabase,
  createDatabasePool,
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

function postMsg(
  token: string,
  body: Record<string, unknown>,
  key = randomUUID()
): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: JSON.stringify(body)
  })
}

async function drainAll(): Promise<void> {
  const loop = createOutboxClaimLoop({
    db,
    workerId: 'mn-w',
    batchSize: 50,
    leaseMs: 30_000,
    pollIntervalMs: 1000,
    maxAttempts: 3,
    baseBackoffMs: 0,
    maxBackoffMs: 0
  })
  for (let i = 0; i < 5; i++) await loop.runOnce()
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED mentions vertical: Docker unavailable — ${String(error)}`)
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
    slug: `mn-${orgId.slice(0, 8)}`,
    displayName: 'MN'
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
  const channel = await jsonOf<{ id: string }>(
    await bearerFetch('owner', `/v1/organizations/${orgId}/channels`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'general' })
    })
  )
  channelId = channel.id
  await addChannelMember(db, { organizationId: orgId, channelId, userId: member2Id })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

async function unreadCount(token: string): Promise<number> {
  const r = await jsonOf<{ items: unknown[] }>(
    await bearerFetch(token, `/v1/organizations/${orgId}/notifications?unread=true`)
  )
  return r.items.length
}

describe('chat mentions + notifications vertical', () => {
  it('a mention notifies the mentioned user and invalidates over realtime', async (ctx) => {
    if (!harness) return ctx.skip()
    const changes: Array<{ resourceType?: string }> = []
    const socket = new WebSocket(wsUrl, { headers: { authorization: 'Bearer member2' } })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
    })
    socket.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString()) as { type?: string; resourceType?: string }
      if (m.type === 'resource.changed' && m.resourceType === 'notification') changes.push(m)
    })
    socket.send(
      JSON.stringify({
        type: 'client.hello',
        schemaVersion: 1,
        protocolVersion: '1.0',
        instanceId: 'mn-test',
        organizationId: orgId,
        lastCursor: null
      })
    )
    await delay(250)
    const before = await unreadCount('member2')
    const posted = await postMsg('owner', { body: 'ping @member2', mentions: [member2Id] })
    expect(posted.status).toBe(201)
    expect(await unreadCount('member2')).toBe(before + 1)
    for (let i = 0; i < 40 && changes.length === 0; i++) {
      await drainAll()
      await delay(50)
    }
    expect(changes.length).toBeGreaterThanOrEqual(1)
    socket.close()
  })

  it("a user cannot see or mark another user's notification (per-user isolation)", async (ctx) => {
    if (!harness) return ctx.skip()
    await postMsg('owner', { body: 'ping again @member2', mentions: [member2Id] })
    const mine = await jsonOf<{ items: Array<{ id: string }> }>(
      await bearerFetch('member2', `/v1/organizations/${orgId}/notifications`)
    )
    const targetId = mine.items[0]!.id
    // The owner (same org) sees none of member2's notifications.
    const ownerList = await jsonOf<{ items: unknown[] }>(
      await bearerFetch('owner', `/v1/organizations/${orgId}/notifications`)
    )
    expect(ownerList.items).toEqual([])
    // The owner cannot mark member2's notification read (RLS → 404).
    const foreign = await bearerFetch(
      'owner',
      `/v1/organizations/${orgId}/notifications/${targetId}/read`,
      { method: 'POST', headers: { 'idempotency-key': randomUUID() } }
    )
    expect(foreign.status).toBe(404)
    // The owner can mark their own.
    const own = await bearerFetch(
      'member2',
      `/v1/organizations/${orgId}/notifications/${targetId}/read`,
      { method: 'POST', headers: { 'idempotency-key': randomUUID() } }
    )
    expect(own.status).toBe(200)
    expect((await jsonOf<{ read: boolean }>(own)).read).toBe(true)
  })

  it('a retried mention-post (same idempotency key) does NOT double-notify', async (ctx) => {
    if (!harness) return ctx.skip()
    const key = randomUUID()
    const before = await unreadCount('member2')
    await postMsg('owner', { body: 'once @member2', mentions: [member2Id] }, key)
    await postMsg('owner', { body: 'once @member2', mentions: [member2Id] }, key)
    expect(await unreadCount('member2')).toBe(before + 1)
  })

  it('drops a mention of a non-member', async (ctx) => {
    if (!harness) return ctx.skip()
    const before = await unreadCount('member2')
    const stranger = randomUUID()
    const posted = await postMsg('owner', { body: 'hi @ghost', mentions: [stranger] })
    expect(posted.status).toBe(201)
    // No new notification for anyone (the stranger isn't a member; no one else mentioned).
    expect(await unreadCount('member2')).toBe(before)
  })
})
