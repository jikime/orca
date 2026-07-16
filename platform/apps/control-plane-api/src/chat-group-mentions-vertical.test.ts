import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  addChannelMember,
  createDatabase,
  createDatabasePool,
  listNotifications,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedEntitlementManifest,
  withTenantTransaction,
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
let ownerId = '' // channel author
let member2Id = ''
let member3Id = ''
let strangerId = '' // org member, NOT a channel member
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

// The stored mention rows for one message — the deterministic ground truth for who a
// post notified (RLS-safe read from the org tenant context).
async function mentionedUserIds(messageId: string): Promise<string[]> {
  const rows = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('collaboration.message_mentions')
      .select('mentioned_user_id')
      .where('message_id', '=', messageId)
      .execute()
  )
  return rows.map((r) => r.mentioned_user_id).sort()
}

// Notifications carry a per-user RLS policy, so they must be read from the target
// user's own context (via the read model), not the org tenant context.
async function notificationCount(messageId: string, userId: string): Promise<number> {
  const { items } = await listNotifications(db, orgId, userId, { limit: 200 })
  return items.filter((n) => n.messageId === messageId).length
}

async function connectWs(token: string): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } })
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
  })
  socket.send(
    JSON.stringify({
      type: 'client.hello',
      schemaVersion: 1,
      protocolVersion: '1.0',
      instanceId: `gm-${randomUUID().slice(0, 8)}`,
      organizationId: orgId,
      lastCursor: null
    })
  )
  // Give the handshake time to register the connection in the gateway's present set.
  await delay(250)
  return socket
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED group-mentions vertical: Docker unavailable — ${String(error)}`)
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
    slug: `gm-${orgId.slice(0, 8)}`,
    displayName: 'GM'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  member2Id = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'member2',
      roleIds: ['member']
    })
  ).userId
  member3Id = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'member3',
      roleIds: ['member']
    })
  ).userId
  strangerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'stranger',
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
  // Roster: owner (creator) + member2 + member3. stranger is an org member but NOT here.
  await addChannelMember(db, { organizationId: orgId, channelId, userId: member2Id })
  await addChannelMember(db, { organizationId: orgId, channelId, userId: member3Id })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat @channel group mention vertical', () => {
  it('notifies every channel member except the author', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await postMsg('owner', { body: 'all hands @channel', mentionChannel: true })
    expect(posted.status).toBe(201)
    const id = (await jsonOf<{ id: string }>(posted)).id
    // Both members, never the author.
    expect(await mentionedUserIds(id)).toEqual([member2Id, member3Id].sort())
    expect(await notificationCount(id, ownerId)).toBe(0)
    expect(await notificationCount(id, member2Id)).toBe(1)
    expect(await notificationCount(id, member3Id)).toBe(1)
  })

  it('a user explicitly mentioned AND covered by @channel gets exactly ONE notification + mention row', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await postMsg('owner', {
      body: 'both ways @member2 @channel',
      mentions: [member2Id],
      mentionChannel: true
    })
    expect(posted.status).toBe(201)
    const id = (await jsonOf<{ id: string }>(posted)).id
    // member2 appears once despite being covered by two scopes.
    expect((await mentionedUserIds(id)).filter((u) => u === member2Id)).toEqual([member2Id])
    expect(await notificationCount(id, member2Id)).toBe(1)
  })
})

describe('chat @here group mention vertical', () => {
  it('notifies only members present on the gateway (member3 offline is not notified)', async (ctx) => {
    if (!harness) return ctx.skip()
    // member2 is present; member3 is NOT connected.
    const present = await connectWs('member2')
    const posted = await postMsg('owner', { body: 'who is around @here', mentionHere: true })
    expect(posted.status).toBe(201)
    const id = (await jsonOf<{ id: string }>(posted)).id
    expect(await mentionedUserIds(id)).toEqual([member2Id])
    expect(await notificationCount(id, member2Id)).toBe(1)
    expect(await notificationCount(id, member3Id)).toBe(0)
    present.close()
  })

  it('drops a present user who is NOT a channel member and never self-notifies the author', async (ctx) => {
    if (!harness) return ctx.skip()
    // stranger (present, org member, but not on this channel's roster) + owner (present author).
    const strangerWs = await connectWs('stranger')
    const ownerWs = await connectWs('owner')
    const member2Ws = await connectWs('member2')
    const posted = await postMsg('owner', { body: 'anyone here @here', mentionHere: true })
    expect(posted.status).toBe(201)
    const id = (await jsonOf<{ id: string }>(posted)).id
    // Only member2: stranger is a non-member (dropped), the author is excluded.
    expect(await mentionedUserIds(id)).toEqual([member2Id])
    expect(await notificationCount(id, strangerId)).toBe(0)
    expect(await notificationCount(id, ownerId)).toBe(0)
    strangerWs.close()
    ownerWs.close()
    member2Ws.close()
  })
})
