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

function postMsg(token: string, body: Record<string, unknown>): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

async function drainOutbox(): Promise<void> {
  await createOutboxClaimLoop({
    db,
    workerId: 'tr-w',
    batchSize: 20,
    leaseMs: 30_000,
    pollIntervalMs: 1000,
    maxAttempts: 3,
    baseBackoffMs: 0,
    maxBackoffMs: 0
  }).runOnce()
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED threads/reactions vertical: Docker unavailable — ${String(error)}`)
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
    slug: `tr-${orgId.slice(0, 8)}`,
    displayName: 'TR'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  const member2Id = (
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
  await addChannelMember(db, { organizationId: orgId, channelId, userId: member2Id })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat threads + reactions vertical', () => {
  it('posts a thread reply, filters the thread, and reports reply count', async (ctx) => {
    if (!harness) return ctx.skip()
    const root = await jsonOf<{ id: string }>(await postMsg('owner', { body: 'root message' }))
    const reply = await postMsg('owner', { body: 'a reply', threadRootMessageId: root.id })
    expect(reply.status).toBe(201)
    const replyBody = await jsonOf<{ threadRootMessageId: string }>(reply)
    expect(replyBody.threadRootMessageId).toBe(root.id)
    // Thread filter returns only the reply.
    const thread = await jsonOf<{ items: Array<{ body: string }> }>(
      await bearerFetch(
        'owner',
        `/v1/organizations/${orgId}/channels/${channelId}/messages?threadRoot=${root.id}`
      )
    )
    expect(thread.items.map((m) => m.body)).toEqual(['a reply'])
    // Whole-channel list shows the root's reply count.
    const all = await jsonOf<{ items: Array<{ id: string; replyCount: number }> }>(
      await bearerFetch('owner', `/v1/organizations/${orgId}/channels/${channelId}/messages`)
    )
    expect(all.items.find((m) => m.id === root.id)?.replyCount).toBe(1)
  })

  it('rejects a reply whose root is not a root in this channel (422)', async (ctx) => {
    if (!harness) return ctx.skip()
    const bad = await postMsg('owner', { body: 'bad', threadRootMessageId: randomUUID() })
    expect(bad.status).toBe(422)
  })

  it('adds a reaction, returns the summary, and invalidates over realtime', async (ctx) => {
    if (!harness) return ctx.skip()
    const msg = await jsonOf<{ id: string }>(await postMsg('owner', { body: 'react here' }))
    const changes: Array<{ resourceType?: string; changeKind?: string }> = []
    const socket = new WebSocket(wsUrl, { headers: { authorization: 'Bearer member2' } })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
    })
    socket.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString()) as {
        type?: string
        resourceType?: string
        changeKind?: string
      }
      if (m.type === 'resource.changed' && m.resourceType === 'message') changes.push(m)
    })
    socket.send(
      JSON.stringify({
        type: 'client.hello',
        schemaVersion: 1,
        protocolVersion: '1.0',
        instanceId: 'tr-test',
        organizationId: orgId,
        lastCursor: null
      })
    )
    await delay(250)
    const reacted = await bearerFetch(
      'member2',
      `/v1/organizations/${orgId}/channels/${channelId}/messages/${msg.id}/reactions`,
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ emoji: '👍' })
      }
    )
    expect(reacted.status).toBe(200)
    const summary = await jsonOf<{
      reactions: Array<{ emoji: string; count: number; reactedByMe: boolean }>
    }>(reacted)
    expect(summary.reactions).toEqual([{ emoji: '👍', count: 1, reactedByMe: true }])
    // Drain repeatedly: earlier tests leave undrained outbox events, so one batch may
    // not reach this reaction's newest message.updated event.
    for (let i = 0; i < 40 && changes.length === 0; i++) {
      await drainOutbox()
      await delay(50)
    }
    expect(changes.some((c) => c.changeKind === 'updated')).toBe(true)
    socket.close()
  })

  it('remove is idempotent (204 whether present or not) and a non-member is denied', async (ctx) => {
    if (!harness) return ctx.skip()
    const msg = await jsonOf<{ id: string }>(await postMsg('owner', { body: 'toggle' }))
    const base = `/v1/organizations/${orgId}/channels/${channelId}/messages/${msg.id}/reactions`
    await bearerFetch('owner', base, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ emoji: '🎉' })
    })
    const removed = await bearerFetch('owner', `${base}?emoji=${encodeURIComponent('🎉')}`, {
      method: 'DELETE',
      headers: { 'idempotency-key': randomUUID() }
    })
    expect(removed.status).toBe(204)
    // Removing again is still 204 (no-op).
    const again = await bearerFetch('owner', `${base}?emoji=${encodeURIComponent('🎉')}`, {
      method: 'DELETE',
      headers: { 'idempotency-key': randomUUID() }
    })
    expect(again.status).toBe(204)
    // A non-member cannot react.
    const denied = await bearerFetch('stranger', base, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ emoji: '👍' })
    })
    expect(denied.status).toBe(403)
  })

  it('dedups a duplicate addReaction with the same idempotency key', async (ctx) => {
    if (!harness) return ctx.skip()
    const msg = await jsonOf<{ id: string }>(await postMsg('owner', { body: 'dedup react' }))
    const base = `/v1/organizations/${orgId}/channels/${channelId}/messages/${msg.id}/reactions`
    const key = randomUUID()
    await bearerFetch('owner', base, {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify({ emoji: '👍' })
    })
    const second = await bearerFetch('owner', base, {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify({ emoji: '👍' })
    })
    expect(second.status).toBe(200)
    const summary = await jsonOf<{ reactions: Array<{ emoji: string; count: number }> }>(second)
    expect(summary.reactions.find((r) => r.emoji === '👍')?.count).toBe(1)
  })
})
