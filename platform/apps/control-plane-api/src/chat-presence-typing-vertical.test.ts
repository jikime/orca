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
  withoutTenantContext,
  type PieDatabase
} from '@pie/persistence'
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
let channelId = ''

type Frame = {
  type?: string
  resourceType?: string
  userId?: string
  state?: string
  channelId?: string
}

type Client = { socket: WebSocket; frames: Frame[]; close: () => void }

async function connect(token: string): Promise<Client> {
  const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } })
  const frames: Frame[] = []
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
  })
  socket.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString()) as Frame))
  socket.send(
    JSON.stringify({
      type: 'client.hello',
      schemaVersion: 1,
      protocolVersion: '1.0',
      instanceId: `pt-${randomUUID().slice(0, 8)}`,
      organizationId: orgId,
      lastCursor: null
    })
  )
  await delay(200)
  return { socket, frames, close: () => socket.close() }
}

async function waitFor(client: Client, predicate: (f: Frame) => boolean): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (client.frames.some(predicate)) return true
    await delay(50)
  }
  return client.frames.some(predicate)
}

function typing(token: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/organizations/${orgId}/channels/${channelId}/typing`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED presence/typing vertical: Docker unavailable — ${String(error)}`)
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
    slug: `pt-${orgId.slice(0, 8)}`,
    displayName: 'PT'
  })
  const aId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'a',
      roleIds: ['organization_owner']
    })
  ).userId
  const bId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'b',
      roleIds: ['member']
    })
  ).userId
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'c',
    roleIds: ['member']
  })
  const channel = await fetch(`${baseUrl}/v1/organizations/${orgId}/channels`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer a',
      'content-type': 'application/json',
      'idempotency-key': randomUUID()
    },
    body: JSON.stringify({ name: 'general' })
  })
  channelId = ((await channel.json()) as { id: string }).id
  // A and B are members; C is not.
  await addChannelMember(db, { organizationId: orgId, channelId, userId: bId })
  // aId is already a member (creator); keep a reference so lint is happy.
  void aId
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('ephemeral: typing', () => {
  it('reaches a channel member, not a non-member, and writes no durable row', async (ctx) => {
    if (!harness) return ctx.skip()
    const b = await connect('b')
    const c = await connect('c')
    const before = await withoutTenantContext(db, async (trx) => ({
      outbox: Number(
        (
          await trx
            .selectFrom('operations.outbox_events')
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow()
        ).n
      ),
      cursors: Number(
        (
          await trx
            .selectFrom('operations.stream_cursors')
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow()
        ).n
      )
    }))
    const r = await typing('a')
    expect(r.status).toBe(204)
    expect(await waitFor(b, (f) => f.type === 'typing.changed' && f.channelId === channelId)).toBe(
      true
    )
    await delay(300)
    // C is not a channel member — must not learn A is typing.
    expect(c.frames.some((f) => f.type === 'typing.changed')).toBe(false)
    // Typing wrote nothing durable.
    const after = await withoutTenantContext(db, async (trx) => ({
      outbox: Number(
        (
          await trx
            .selectFrom('operations.outbox_events')
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow()
        ).n
      ),
      cursors: Number(
        (
          await trx
            .selectFrom('operations.stream_cursors')
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow()
        ).n
      )
    }))
    expect(after).toEqual(before)
    b.close()
    c.close()
  })

  it('coalesces a flood to at most one ping per second', async (ctx) => {
    if (!harness) return ctx.skip()
    const b = await connect('b')
    // Clear any coalesce window left by a prior test (the rate cap is per user+channel,
    // shared across this file), so the first of the flood is guaranteed to fire.
    await delay(1100)
    for (let i = 0; i < 6; i++) await typing('a')
    await delay(400)
    const pings = b.frames.filter((f) => f.type === 'typing.changed').length
    expect(pings).toBeLessThanOrEqual(2)
    expect(pings).toBeGreaterThanOrEqual(1)
    b.close()
  })
})

describe('ephemeral: presence', () => {
  it('broadcasts online on connect and offline on last disconnect', async (ctx) => {
    if (!harness) return ctx.skip()
    const b = await connect('b')
    const a = await connect('a')
    expect(
      await waitFor(
        b,
        (f) => f.type === 'presence.changed' && f.userId != null && f.state === 'online'
      )
    ).toBe(true)
    a.close()
    expect(await waitFor(b, (f) => f.type === 'presence.changed' && f.state === 'offline')).toBe(
      true
    )
    b.close()
  })

  it('keeps a user online while any connection remains (multi-tab)', async (ctx) => {
    if (!harness) return ctx.skip()
    const observer = await connect('b')
    const tab1 = await connect('a')
    await delay(200)
    const tab2 = await connect('a')
    await delay(200)
    observer.frames.length = 0
    tab1.close()
    await delay(400)
    // Closing one of A's two tabs must NOT emit offline.
    expect(
      observer.frames.some((f) => f.type === 'presence.changed' && f.state === 'offline')
    ).toBe(false)
    tab2.close()
    expect(
      await waitFor(observer, (f) => f.type === 'presence.changed' && f.state === 'offline')
    ).toBe(true)
    observer.close()
  })
})

describe('durable path unaffected', () => {
  it('a normal message still delivers via resource.changed independently', async (ctx) => {
    if (!harness) return ctx.skip()
    const { createOutboxClaimLoop } = await import('@pie/control-plane-worker/outbox-claim-loop')
    const b = await connect('b')
    await fetch(`${baseUrl}/v1/organizations/${orgId}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer a',
        'content-type': 'application/json',
        'idempotency-key': randomUUID()
      },
      body: JSON.stringify({ body: 'durable still works' })
    })
    await createOutboxClaimLoop({
      db,
      workerId: 'pt-w',
      batchSize: 20,
      leaseMs: 30_000,
      pollIntervalMs: 1000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0
    }).runOnce()
    expect(
      await waitFor(b, (f) => f.type === 'resource.changed' && f.resourceType === 'message')
    ).toBe(true)
    b.close()
  })
})
