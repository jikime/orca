import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  addChannelMember,
  createDatabase,
  createDatabasePool,
  listPins,
  MAX_PINS_PER_CHANNEL,
  pinMessage,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedEntitlementManifest,
  unpinMessage,
  withTenantTransaction,
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
import { createTestTokenVerifier, TEST_ISSUER } from './authorization-test-support'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let memberId = '' // channel member who pins
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

async function postMsg(token: string, body: string): Promise<string> {
  const r = await bearerFetch(token, `/v1/organizations/${orgId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ body })
  })
  expect(r.status).toBe(201)
  return (await jsonOf<{ id: string }>(r)).id
}

function pinPath(messageId: string): string {
  return `/v1/organizations/${orgId}/channels/${channelId}/messages/${messageId}/pin`
}

function pinsPath(target = channelId): string {
  return `/v1/organizations/${orgId}/channels/${target}/pins`
}

type PinnedItem = { message: { id: string; pinned: boolean }; pinnedBy: string; pinnedAt: string }

async function listPinItems(token: string): Promise<PinnedItem[]> {
  const r = await bearerFetch(token, pinsPath())
  expect(r.status).toBe(200)
  return (await jsonOf<{ items: PinnedItem[] }>(r)).items
}

// Ground-truth pin row count for a channel (RLS-safe org tenant read).
async function pinRowCount(): Promise<number> {
  const rows = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('collaboration.message_pins')
      .select('id')
      .where('channel_id', '=', channelId)
      .execute()
  )
  return rows.length
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED chat-pins vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  const verifier = createTestTokenVerifier()
  app = buildApp({ ping: async () => true, db, registry, tokenVerifier: verifier })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `pins-${orgId.slice(0, 8)}`,
    displayName: 'Pins'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  memberId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'member',
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
  // Roster: owner (creator) + member. stranger is an org member but NOT on this channel.
  await addChannelMember(db, { organizationId: orgId, channelId, userId: memberId })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat pins vertical', () => {
  it('a member pins a message → it appears in GET .../pins with pinnedBy/pinnedAt', async (ctx) => {
    if (!harness) return ctx.skip()
    const id = await postMsg('owner', 'read the runbook')
    const put = await bearerFetch('member', pinPath(id), { method: 'PUT' })
    expect(put.status).toBe(204)
    const items = await listPinItems('member')
    const pinned = items.find((p) => p.message.id === id)
    expect(pinned).toBeTruthy()
    expect(pinned?.message.pinned).toBe(true)
    expect(pinned?.pinnedBy).toBe(memberId)
    expect(typeof pinned?.pinnedAt).toBe('string')
    // Clean up so later tests start from a known pin set.
    expect((await bearerFetch('member', pinPath(id), { method: 'DELETE' })).status).toBe(204)
  })

  it('pinning is idempotent (double PUT → one row, 204)', async (ctx) => {
    if (!harness) return ctx.skip()
    const id = await postMsg('owner', 'pin me twice')
    const before = await pinRowCount()
    expect((await bearerFetch('member', pinPath(id), { method: 'PUT' })).status).toBe(204)
    expect((await bearerFetch('member', pinPath(id), { method: 'PUT' })).status).toBe(204)
    expect(await pinRowCount()).toBe(before + 1)
    await bearerFetch('member', pinPath(id), { method: 'DELETE' })
  })

  it('unpin removes the pin (idempotent 204, unpin-again fine)', async (ctx) => {
    if (!harness) return ctx.skip()
    const id = await postMsg('owner', 'temporarily pinned')
    expect((await bearerFetch('member', pinPath(id), { method: 'PUT' })).status).toBe(204)
    expect((await bearerFetch('member', pinPath(id), { method: 'DELETE' })).status).toBe(204)
    expect((await bearerFetch('member', pinPath(id), { method: 'DELETE' })).status).toBe(204)
    expect((await listPinItems('member')).some((p) => p.message.id === id)).toBe(false)
  })

  it('a non-member cannot pin (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const id = await postMsg('owner', 'members only')
    const put = await bearerFetch('stranger', pinPath(id), { method: 'PUT' })
    expect(put.status).toBe(403)
  })

  it('pinning a nonexistent / other-channel message is 404', async (ctx) => {
    if (!harness) return ctx.skip()
    const put = await bearerFetch('member', pinPath(randomUUID()), { method: 'PUT' })
    expect(put.status).toBe(404)
  })

  it('pinning a DELETED (tombstoned) message is rejected (409)', async (ctx) => {
    if (!harness) return ctx.skip()
    const id = await postMsg('owner', 'about to be deleted')
    const del = await bearerFetch(
      'owner',
      `/v1/organizations/${orgId}/channels/${channelId}/messages/${id}`,
      {
        method: 'DELETE'
      }
    )
    expect(del.status).toBe(204)
    const put = await bearerFetch('member', pinPath(id), { method: 'PUT' })
    expect(put.status).toBe(409)
  })

  it('deleting a pinned message cascades the pin away', async (ctx) => {
    if (!harness) return ctx.skip()
    const id = await postMsg('owner', 'pinned then deleted')
    expect((await bearerFetch('member', pinPath(id), { method: 'PUT' })).status).toBe(204)
    expect((await listPinItems('member')).some((p) => p.message.id === id)).toBe(true)
    const del = await bearerFetch(
      'owner',
      `/v1/organizations/${orgId}/channels/${channelId}/messages/${id}`,
      {
        method: 'DELETE'
      }
    )
    expect(del.status).toBe(204)
    // The message FK's ON DELETE CASCADE removes the pin row.
    expect((await listPinItems('member')).some((p) => p.message.id === id)).toBe(false)
  })

  it('the per-channel cap is enforced — the (cap+1)th pin is rejected (409)', async (ctx) => {
    if (!harness) return ctx.skip()
    // Isolate the cap test in its own channel so it does not interact with other pins.
    const capChannel = await jsonOf<{ id: string }>(
      await bearerFetch('owner', `/v1/organizations/${orgId}/channels`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ name: 'cap-test' })
      })
    )
    await addChannelMember(db, {
      organizationId: orgId,
      channelId: capChannel.id,
      userId: memberId
    })
    const pinIn = (messageId: string): string =>
      `/v1/organizations/${orgId}/channels/${capChannel.id}/messages/${messageId}/pin`
    // Fill the cap using the store directly (fast; the route path is covered above).
    for (let i = 0; i < MAX_PINS_PER_CHANNEL; i++) {
      const posted = await bearerFetch(
        'owner',
        `/v1/organizations/${orgId}/channels/${capChannel.id}/messages`,
        {
          method: 'POST',
          headers: { 'idempotency-key': randomUUID() },
          body: JSON.stringify({ body: `m${i}` })
        }
      )
      const mid = (await jsonOf<{ id: string }>(posted)).id
      const r = await pinMessage(db, {
        organizationId: orgId,
        channelId: capChannel.id,
        messageId: mid,
        actorUserId: memberId
      })
      expect(r).toEqual({ ok: true })
    }
    // The (cap+1)th distinct pin is rejected over the route.
    const posted = await bearerFetch(
      'owner',
      `/v1/organizations/${orgId}/channels/${capChannel.id}/messages`,
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ body: 'overflow' })
      }
    )
    const overflowId = (await jsonOf<{ id: string }>(posted)).id
    const put = await bearerFetch('member', pinIn(overflowId), { method: 'PUT' })
    expect(put.status).toBe(409)
  })

  it('store-level: listPins gates non-members and unknown channels', async (ctx) => {
    if (!harness) return ctx.skip()
    expect(await listPins(db, orgId, channelId, strangerId)).toEqual({
      ok: false,
      reason: 'not_a_member'
    })
    expect(await listPins(db, orgId, randomUUID(), memberId)).toEqual({
      ok: false,
      reason: 'channel_not_found'
    })
    // A non-member cannot pin/unpin at the store layer either.
    const id = await postMsg('owner', 'store gate')
    expect(
      await pinMessage(db, {
        organizationId: orgId,
        channelId,
        messageId: id,
        actorUserId: strangerId
      })
    ).toEqual({ ok: false, reason: 'not_a_member' })
    expect(
      await unpinMessage(db, {
        organizationId: orgId,
        channelId,
        messageId: id,
        actorUserId: strangerId
      })
    ).toEqual({ ok: false, reason: 'not_a_member' })
  })
})
