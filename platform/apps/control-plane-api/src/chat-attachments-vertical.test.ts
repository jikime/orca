import { randomUUID } from 'node:crypto'
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
import { createObjectStorage, type ObjectStorage } from '@pie/object-storage-adapter'
import {
  startObjectStorageHarness,
  type ObjectStorageHarness
} from '@pie/object-storage-adapter/testing'
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

let pgHarness: PostgresHarness | null = null
let s3Harness: ObjectStorageHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let storage: ObjectStorage
let gateway: RealtimeGateway
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let userBId = ''
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

async function intent(token: string, body: Record<string, unknown>): Promise<Response> {
  return bearerFetch(
    token,
    `/v1/organizations/${orgId}/channels/${channelId}/attachments/intents`,
    {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify(body)
    }
  )
}

// Full happy path: intent → PUT bytes → post with attachmentId → returns the linked id.
async function uploadAndAttach(
  token: string,
  bytes: Uint8Array,
  contentType: string
): Promise<{ messageId: string; attachmentId: string }> {
  const created = await jsonOf<{ id: string; uploadUrl: string }>(
    await intent(token, { filename: 'diagram.png', contentType, byteSize: bytes.byteLength })
  )
  const put = await fetch(created.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: bytes
  })
  expect(put.status).toBe(200)
  const posted = await jsonOf<{ id: string }>(
    await bearerFetch(token, `/v1/organizations/${orgId}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ body: 'here is a file', attachmentIds: [created.id] })
    })
  )
  return { messageId: posted.id, attachmentId: created.id }
}

beforeAll(async () => {
  try {
    pgHarness = await startPostgresHarness()
    s3Harness = await startObjectStorageHarness()
  } catch (error) {
    console.warn(`SKIPPED attachments vertical: Docker/Postgres/S3 unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: pgHarness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  storage = createObjectStorage(s3Harness)
  await storage.ensureBucket()
  const verifier = createTestTokenVerifier()
  gateway = createRealtimeGateway({
    db,
    registry,
    listenConnectionString: pgHarness.connectionString,
    heartbeatIntervalMs: 60_000,
    authorizeConnection: createGatewayConnectionAuthorizer(db, verifier)
  })
  app = buildApp({
    ping: async () => true,
    db,
    registry,
    gateway,
    objectStorage: storage,
    tokenVerifier: verifier
  })
  await app.ready()
  await gateway.start()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `at-${orgId.slice(0, 8)}`,
    displayName: 'AT'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'a',
    roleIds: ['organization_owner']
  })
  userBId = (
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
  const channel = await jsonOf<{ id: string }>(
    await bearerFetch('a', `/v1/organizations/${orgId}/channels`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'general' })
    })
  )
  channelId = channel.id
  await addChannelMember(db, { organizationId: orgId, channelId, userId: userBId })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await pgHarness?.stop()
  await s3Harness?.stop()
})

describe('chat attachments vertical', () => {
  it('intent → PUT → post → the message carries the attachment; another member downloads it', async (ctx) => {
    if (!pgHarness || !s3Harness) return ctx.skip()
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const { messageId, attachmentId } = await uploadAndAttach(
      'a',
      bytes,
      'application/octet-stream'
    )
    // The message read shows the attachment summary — and NO raw storage key.
    const list = await jsonOf<{
      items: Array<{ id: string; attachments?: Array<Record<string, unknown>> }>
    }>(await bearerFetch('a', `/v1/organizations/${orgId}/channels/${channelId}/messages`))
    const msg = list.items.find((m) => m.id === messageId)
    expect(msg?.attachments?.length).toBe(1)
    const summary = msg!.attachments![0]!
    expect(summary).toMatchObject({
      id: attachmentId,
      filename: 'diagram.png',
      byteSize: bytes.byteLength
    })
    expect(summary).not.toHaveProperty('storageKey')
    expect(summary).not.toHaveProperty('objectId')
    // A member (B) gets a short-lived download URL and the bytes round-trip.
    const dl = await jsonOf<{ url: string }>(
      await bearerFetch(
        'b',
        `/v1/organizations/${orgId}/channels/${channelId}/attachments/${attachmentId}/download`
      )
    )
    const object = await fetch(dl.url)
    expect(object.status).toBe(200)
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(bytes)
    // The stored key is under the tenant + attachments zone.
    const key = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('collaboration.message_attachments')
        .select('storage_key')
        .where('id', '=', attachmentId)
        .executeTakeFirstOrThrow()
    )
    expect(key.storage_key).toBe(
      `org/${orgId}/attachments/${(await withoutTenantContext(db, (trx) => trx.selectFrom('collaboration.message_attachments').select('object_id').where('id', '=', attachmentId).executeTakeFirstOrThrow())).object_id}`
    )
  })

  it('a non-member cannot intent or download (403)', async (ctx) => {
    if (!pgHarness || !s3Harness) return ctx.skip()
    const bytes = new Uint8Array([9, 9, 9])
    const { attachmentId } = await uploadAndAttach('a', bytes, 'application/octet-stream')
    const cIntent = await intent('c', {
      filename: 'x.bin',
      contentType: 'application/octet-stream',
      byteSize: 3
    })
    expect(cIntent.status).toBe(403)
    const cDownload = await bearerFetch(
      'c',
      `/v1/organizations/${orgId}/channels/${channelId}/attachments/${attachmentId}/download`
    )
    expect(cDownload.status).toBe(403)
  })

  it('rejects oversize, path-like filename, and a size mismatch', async (ctx) => {
    if (!pgHarness || !s3Harness) return ctx.skip()
    // Oversize byteSize (> 25MB) rejected at intent by the schema.
    expect(
      (
        await intent('a', {
          filename: 'big.bin',
          contentType: 'application/octet-stream',
          byteSize: 99999999
        })
      ).status
    ).toBe(400)
    // A path-like filename is rejected (the server derives the key, never the client).
    expect(
      (await intent('a', { filename: '../../etc/passwd', contentType: 'text/plain', byteSize: 10 }))
        .status
    ).toBe(400)
    // Declared size that doesn't match the uploaded object → 422 at post.
    const created = await jsonOf<{ id: string; uploadUrl: string }>(
      await intent('a', {
        filename: 'x.bin',
        contentType: 'application/octet-stream',
        byteSize: 100
      })
    )
    await fetch(created.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3])
    })
    const posted = await bearerFetch(
      'a',
      `/v1/organizations/${orgId}/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ body: 'mismatch', attachmentIds: [created.id] })
      }
    )
    expect(posted.status).toBe(422)
  })

  it('works in a DM (a DM is a channel)', async (ctx) => {
    if (!pgHarness || !s3Harness) return ctx.skip()
    const dm = await jsonOf<{ id: string }>(
      await bearerFetch('a', `/v1/organizations/${orgId}/dms`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ otherUserId: userBId })
      })
    )
    const bytes = new Uint8Array([42, 42, 42, 42])
    const created = await jsonOf<{ id: string; uploadUrl: string }>(
      await bearerFetch('a', `/v1/organizations/${orgId}/channels/${dm.id}/attachments/intents`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({
          filename: 'dm.bin',
          contentType: 'application/octet-stream',
          byteSize: bytes.byteLength
        })
      })
    )
    await fetch(created.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes
    })
    const posted = await bearerFetch('a', `/v1/organizations/${orgId}/channels/${dm.id}/messages`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ body: 'file in a DM', attachmentIds: [created.id] })
    })
    expect(posted.status).toBe(201)
    expect((await jsonOf<{ attachments: unknown[] }>(posted)).attachments.length).toBe(1)
  })
})
