import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  addChannelMember,
  createDatabase,
  createDatabasePool,
  listNotifications,
  muteChannel,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedEntitlementManifest,
  unmuteChannel,
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
let muterId = '' // member who mutes the channel
let baselineId = '' // member who never mutes (baseline)
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

function mutePath(target: string): string {
  return `/v1/organizations/${orgId}/channels/${target}/mute`
}

// The stored mention rows for a message — the ground truth for who a post individually
// recorded a mention against (RLS-safe read from the org tenant context).
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

// Notifications carry a per-user RLS policy, so they must be read from the target user's
// own context (via the read model), not the org tenant context.
async function notificationCount(messageId: string, userId: string): Promise<number> {
  const { items } = await listNotifications(db, orgId, userId, { limit: 200 })
  return items.filter((n) => n.messageId === messageId).length
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED channel-mute vertical: Docker unavailable — ${String(error)}`)
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
    slug: `mute-${orgId.slice(0, 8)}`,
    displayName: 'Mute'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  muterId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'muter',
      roleIds: ['member']
    })
  ).userId
  baselineId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'baseline',
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
  // Roster: owner (creator) + muter + baseline. stranger is an org member but NOT here.
  await addChannelMember(db, { organizationId: orgId, channelId, userId: muterId })
  await addChannelMember(db, { organizationId: orgId, channelId, userId: baselineId })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat channel mute vertical', () => {
  it('a muted user swept up ONLY by @channel gets no notification and no mention row', async (ctx) => {
    if (!harness) return ctx.skip()
    const put = await bearerFetch('muter', mutePath(channelId), { method: 'PUT' })
    expect(put.status).toBe(204)
    const posted = await postMsg('owner', { body: 'all hands @channel', mentionChannel: true })
    expect(posted.status).toBe(201)
    const id = (await jsonOf<{ id: string }>(posted)).id
    // muter is muted → dropped from BOTH the notification and the mention row; baseline stays.
    expect(await mentionedUserIds(id)).toEqual([baselineId])
    expect(await notificationCount(id, muterId)).toBe(0)
    expect(await notificationCount(id, baselineId)).toBe(1)
  })

  it('a muted user ALSO explicitly @mentioned still gets exactly one notification (direct pierces mute)', async (ctx) => {
    if (!harness) return ctx.skip()
    // muter remains muted from the prior test.
    const posted = await postMsg('owner', {
      body: 'need you @muter @channel',
      mentions: [muterId],
      mentionChannel: true
    })
    expect(posted.status).toBe(201)
    const id = (await jsonOf<{ id: string }>(posted)).id
    // The explicit path pierces the mute: exactly one notification + one mention row.
    expect((await mentionedUserIds(id)).filter((u) => u === muterId)).toEqual([muterId])
    expect(await notificationCount(id, muterId)).toBe(1)
  })

  it('an unmuted member swept up by @channel is notified (baseline)', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await postMsg('owner', { body: 'ping all @channel', mentionChannel: true })
    expect(posted.status).toBe(201)
    const id = (await jsonOf<{ id: string }>(posted)).id
    expect(await notificationCount(id, baselineId)).toBe(1)
  })

  it('unmuting restores broadcast notifications', async (ctx) => {
    if (!harness) return ctx.skip()
    const del = await bearerFetch('muter', mutePath(channelId), { method: 'DELETE' })
    expect(del.status).toBe(204)
    const posted = await postMsg('owner', { body: 'back on @channel', mentionChannel: true })
    expect(posted.status).toBe(201)
    const id = (await jsonOf<{ id: string }>(posted)).id
    // After unmute the broadcast reaches muter again — mention row + notification return.
    expect(await mentionedUserIds(id)).toEqual([baselineId, muterId].sort())
    expect(await notificationCount(id, muterId)).toBe(1)
  })

  it('a non-member cannot mute the channel (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const put = await bearerFetch('stranger', mutePath(channelId), { method: 'PUT' })
    expect(put.status).toBe(403)
  })

  it('muting an unknown channel is 404', async (ctx) => {
    if (!harness) return ctx.skip()
    const put = await bearerFetch('muter', mutePath(randomUUID()), { method: 'PUT' })
    expect(put.status).toBe(404)
  })

  it('mute is idempotent (double PUT is fine)', async (ctx) => {
    if (!harness) return ctx.skip()
    const first = await bearerFetch('muter', mutePath(channelId), { method: 'PUT' })
    const second = await bearerFetch('muter', mutePath(channelId), { method: 'PUT' })
    expect(first.status).toBe(204)
    expect(second.status).toBe(204)
    // Leave the channel unmuted so the suite has no order coupling beyond what's asserted.
    const del = await bearerFetch('muter', mutePath(channelId), { method: 'DELETE' })
    expect(del.status).toBe(204)
  })

  it('store-level: muteChannel/unmuteChannel gate non-members and are idempotent', async (ctx) => {
    if (!harness) return ctx.skip()
    // Non-member is rejected regardless of transport.
    const denied = await muteChannel(db, { organizationId: orgId, channelId, userId: strangerId })
    expect(denied).toEqual({ ok: false, reason: 'not_a_member' })
    // Unknown channel is a 404-shaped signal.
    const missing = await muteChannel(db, {
      organizationId: orgId,
      channelId: randomUUID(),
      userId: muterId
    })
    expect(missing).toEqual({ ok: false, reason: 'channel_not_found' })
    // Member mute/unmute is idempotent both ways.
    expect(await muteChannel(db, { organizationId: orgId, channelId, userId: muterId })).toEqual({
      ok: true
    })
    expect(await muteChannel(db, { organizationId: orgId, channelId, userId: muterId })).toEqual({
      ok: true
    })
    expect(await unmuteChannel(db, { organizationId: orgId, channelId, userId: muterId })).toEqual({
      ok: true
    })
    expect(await unmuteChannel(db, { organizationId: orgId, channelId, userId: muterId })).toEqual({
      ok: true
    })
  })
})
