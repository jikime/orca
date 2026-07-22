import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  addChannelMember,
  createDatabase,
  createDatabasePool,
  runMigrations,
  seedEntitlementManifest,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  withTenantTransaction,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { createTestTokenVerifier, TEST_ISSUER } from './authorization-test-support'
import { createContractSchemaRegistry } from './contract-schema-registry'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let channelId = ''
let memberId = ''

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

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function channelPath(suffix = ''): string {
  return `/v1/organizations/${orgId}/channels/${channelId}${suffix}`
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED channel governance vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  app = buildApp({
    ping: async () => true,
    db,
    registry: createContractSchemaRegistry(),
    tokenVerifier: createTestTokenVerifier()
  })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `govern-${orgId.slice(0, 8)}`,
    displayName: 'Channel governance'
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
  const created = await bearerFetch('owner', `/v1/organizations/${orgId}/channels`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ name: 'governance' })
  })
  channelId = (await jsonOf<{ id: string }>(created)).id
  await addChannelMember(db, { organizationId: orgId, channelId, userId: memberId })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat channel governance vertical', () => {
  it('enforces moderation, retention, export, audit, and admin authorization', async (ctx) => {
    if (!harness) return ctx.skip()

    const policy = await bearerFetch('owner', channelPath(), {
      method: 'PATCH',
      headers: { 'if-match': '"channel-1"', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ retentionDays: 1 })
    })
    expect(policy.status).toBe(200)
    expect((await jsonOf<{ retentionDays: number }>(policy)).retentionDays).toBe(1)

    const moderated = await bearerFetch('member', channelPath('/messages'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ body: 'remove this' })
    })
    const moderatedId = (await jsonOf<{ id: string }>(moderated)).id
    const missingReason = await bearerFetch('owner', channelPath(`/messages/${moderatedId}`), {
      method: 'DELETE'
    })
    expect(missingReason.status).toBe(400)
    const removed = await bearerFetch('owner', channelPath(`/messages/${moderatedId}`), {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'policy violation' })
    })
    expect(removed.status).toBe(204)

    const expired = await bearerFetch('member', channelPath('/messages'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ body: 'expired body' })
    })
    const expiredId = (await jsonOf<{ id: string }>(expired)).id
    await withTenantTransaction(db, orgId, (trx) =>
      trx
        .updateTable('collaboration.messages')
        .set({ created_at: new Date('2020-01-01T00:00:00.000Z') })
        .where('id', '=', expiredId)
        .execute()
    )
    await withTenantTransaction(db, orgId, (trx) =>
      trx
        .insertInto('collaboration.messages')
        .values(
          Array.from({ length: 1_001 }, (_, index) => ({
            organization_id: orgId,
            channel_id: channelId,
            author_user_id: memberId,
            body: `expired bulk ${index}`,
            created_at: new Date('2020-01-01T00:00:00.000Z'),
            updated_at: new Date('2020-01-01T00:00:00.000Z')
          }))
        )
        .execute()
    )
    const applied = await bearerFetch('owner', channelPath('/retention:apply'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() }
    })
    expect(applied.status).toBe(200)
    expect((await jsonOf<{ redactedCount: number }>(applied)).redactedCount).toBe(1_002)

    const exported = await jsonOf<{
      messages: Array<{ id: string; body: string; deletionReason: string | null }>
    }>(await bearerFetch('owner', channelPath('/export')))
    expect(exported.messages.find((item) => item.id === expiredId)).toMatchObject({
      body: '',
      deletionReason: 'retention policy'
    })
    expect(exported.messages.find((item) => item.id === moderatedId)).toMatchObject({
      body: '',
      deletionReason: 'policy violation'
    })

    const audit = await jsonOf<{
      items: Array<{ action: string; reason: string | null }>
    }>(await bearerFetch('owner', channelPath('/audit')))
    expect(audit.items).toContainEqual(
      expect.objectContaining({ action: 'message.deleted', reason: 'policy violation' })
    )
    expect(audit.items).toContainEqual(
      expect.objectContaining({ action: 'channel.retention_applied' })
    )
    expect((await bearerFetch('member', channelPath('/audit'))).status).toBe(403)
    expect((await bearerFetch('member', channelPath('/export'))).status).toBe(403)
  })
})
