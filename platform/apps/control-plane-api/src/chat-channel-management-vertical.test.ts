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
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { createContractSchemaRegistry } from './contract-schema-registry'
import { createTestTokenVerifier, TEST_ISSUER } from './authorization-test-support'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let channelId = ''
let memberId = ''
let projectId = ''
let customerId = ''
let ticketId = ''

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

async function patchChannel(
  token: string,
  version: number,
  body: Record<string, unknown>
): Promise<Response> {
  return bearerFetch(token, channelPath(), {
    method: 'PATCH',
    headers: { 'if-match': `"channel-${version}"`, 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED channel management vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  const registry = createContractSchemaRegistry()
  app = buildApp({
    ping: async () => true,
    db,
    registry,
    tokenVerifier: createTestTokenVerifier()
  })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `manage-${orgId.slice(0, 8)}`,
    displayName: 'Channel management'
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
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'stranger',
    roleIds: ['member']
  })
  const created = await bearerFetch('owner', `/v1/organizations/${orgId}/channels`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ name: 'delivery' })
  })
  channelId = (await jsonOf<{ id: string }>(created)).id
  await addChannelMember(db, { organizationId: orgId, channelId, userId: memberId })

  await bearerFetch('owner', `/v1/organizations/${orgId}/teams`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ key: 'CTX', name: 'Context team' })
  })
  projectId = (
    await jsonOf<{ id: string }>(
      await bearerFetch('owner', `/v1/organizations/${orgId}/projects`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ name: 'Apollo' })
      })
    )
  ).id
  customerId = (
    await jsonOf<{ id: string }>(
      await bearerFetch('owner', `/v1/organizations/${orgId}/crm/accounts`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ name: 'Acme' })
      })
    )
  ).id
  ticketId = (
    await jsonOf<{ id: string }>(
      await bearerFetch('owner', `/v1/organizations/${orgId}/service/tickets`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ accountId: customerId, subject: 'Login blocked' })
      })
    )
  ).id
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat channel management vertical', () => {
  it('lists the roster only for channel members', async (ctx) => {
    if (!harness) return ctx.skip()
    const response = await bearerFetch('member', channelPath('/members'))
    expect(response.status).toBe(200)
    const roster = await jsonOf<{ items: Array<{ userId: string; role: string }> }>(response)
    expect(roster.items).toHaveLength(2)
    expect(roster.items).toContainEqual({
      userId: memberId,
      role: 'member',
      addedAt: expect.any(String)
    })
    expect((await bearerFetch('stranger', channelPath('/members'))).status).toBe(403)
  })

  it('updates metadata with OCC and archives the channel as read-only', async (ctx) => {
    if (!harness) return ctx.skip()
    const updated = await patchChannel('owner', 1, {
      topic: 'Release train',
      description: 'Coordination for production releases',
      archived: true
    })
    expect(updated.status).toBe(200)
    expect(updated.headers.get('etag')).toBe('"channel-2"')
    const channel = await jsonOf<{
      topic: string
      description: string
      archivedAt: string | null
      version: number
    }>(updated)
    expect(channel).toMatchObject({
      topic: 'Release train',
      description: 'Coordination for production releases',
      version: 2
    })
    expect(channel.archivedAt).not.toBeNull()

    const post = await bearerFetch('owner', channelPath('/messages'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ body: 'must remain read-only' })
    })
    expect(post.status).toBe(409)
    expect((await jsonOf<{ code: string }>(post)).code).toBe('CHANNEL_ARCHIVED')
    expect((await patchChannel('owner', 1, { topic: 'stale' })).status).toBe(409)

    const restored = await patchChannel('owner', 2, { archived: false })
    expect(restored.status).toBe(200)
    expect((await jsonOf<{ archivedAt: string | null }>(restored)).archivedAt).toBeNull()
  })

  it('requires channel.manage and protects the last owner', async (ctx) => {
    if (!harness) return ctx.skip()
    expect((await patchChannel('member', 3, { topic: 'forbidden' })).status).toBe(403)
    const ownerId = (await jsonOf<{ userId: string }>(await bearerFetch('owner', '/v1/session')))
      .userId
    const removeOwner = await bearerFetch('owner', channelPath(`/members/${ownerId}`), {
      method: 'DELETE'
    })
    expect(removeOwner.status).toBe(409)
    expect((await jsonOf<{ code: string }>(removeOwner)).code).toBe('LAST_CHANNEL_OWNER')
  })

  it('removes a member and immediately revokes channel access', async (ctx) => {
    if (!harness) return ctx.skip()
    const removed = await bearerFetch('owner', channelPath(`/members/${memberId}`), {
      method: 'DELETE'
    })
    expect(removed.status).toBe(204)
    expect((await bearerFetch('member', channelPath('/messages'))).status).toBe(403)
    // Repeating the removal is intentionally idempotent for retry-safe admin UI.
    expect(
      (
        await bearerFetch('owner', channelPath(`/members/${memberId}`), {
          method: 'DELETE'
        })
      ).status
    ).toBe(204)
  })

  it('creates one canonical project, customer, and ticket channel and joins later viewers', async (ctx) => {
    if (!harness) return ctx.skip()
    const createContext = (
      token: string,
      scopeType: 'project' | 'customer' | 'ticket',
      scopeId: string,
      name: string
    ) =>
      bearerFetch(token, `/v1/organizations/${orgId}/channels`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ name, scopeType, scopeId })
      })

    const projectResponse = await createContext('owner', 'project', projectId, 'Apollo')
    expect(projectResponse.status).toBe(201)
    const projectChannel = await jsonOf<{ id: string; scopeType: string; scopeId: string }>(
      projectResponse
    )
    expect(projectChannel).toMatchObject({ scopeType: 'project', scopeId: projectId })

    const joined = await createContext('member', 'project', projectId, 'ignored duplicate name')
    expect(joined.status).toBe(200)
    expect((await jsonOf<{ id: string }>(joined)).id).toBe(projectChannel.id)
    expect(
      (
        await bearerFetch(
          'member',
          `/v1/organizations/${orgId}/channels/${projectChannel.id}/messages`
        )
      ).status
    ).toBe(200)

    const customer = await createContext('owner', 'customer', customerId, 'Acme')
    const ticket = await createContext('owner', 'ticket', ticketId, 'Login blocked')
    expect(customer.status).toBe(201)
    expect(ticket.status).toBe(201)
    expect((await jsonOf<{ scopeType: string }>(customer)).scopeType).toBe('customer')
    expect((await jsonOf<{ scopeType: string }>(ticket)).scopeType).toBe('ticket')

    const missing = await createContext('owner', 'project', randomUUID(), 'Missing')
    expect(missing.status).toBe(404)
    expect((await jsonOf<{ code: string }>(missing)).code).toBe('CONTEXT_NOT_FOUND')
  })
})
