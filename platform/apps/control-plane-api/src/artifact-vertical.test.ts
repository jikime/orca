import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  claimOutboxBatch,
  createDatabase,
  createDatabasePool,
  publishClaimedEvent,
  runMigrations,
  seedOrganizationFixture,
  seedMembershipFixture,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import { createObjectStorage, type ObjectStorage } from '@pie/object-storage-adapter'
import {
  startObjectStorageHarness,
  type ObjectStorageHarness
} from '@pie/object-storage-adapter/testing'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import {
  createContractSchemaRegistry,
  type ContractSchemaRegistry
} from './contract-schema-registry'
import { createRealtimeGateway, type RealtimeGateway } from './realtime-gateway'
import {
  allowAllConnections,
  createTestTokenVerifier,
  TEST_ISSUER
} from './authorization-test-support'

let pgHarness: PostgresHarness | null = null
let s3Harness: ObjectStorageHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let gateway: RealtimeGateway
let storage: ObjectStorage
let app: FastifyInstance
let baseUrl = ''
let wsUrl = ''
let orgId = ''

const SHA256 = 'a'.repeat(64)
const SIZE_BYTES = 4096

function intentBody(overrides: Record<string, unknown> = {}) {
  return {
    projectId: '10000000-0000-4000-8000-000000000002',
    workItemId: null,
    name: 'contract-report.pdf',
    contentType: 'application/pdf',
    sizeBytes: SIZE_BYTES,
    sha256: SHA256,
    classification: 'project_confidential',
    visibility: 'project',
    ...overrides
  }
}

const ARTIFACT_SUBJECT = 'artifact-tester'
const AUTH_HEADER = { authorization: `Bearer ${ARTIFACT_SUBJECT}` }

async function postIntent(org: string, body: unknown, key: string) {
  return fetch(`${baseUrl}/v1/organizations/${org}/artifacts/upload-intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...AUTH_HEADER },
    body: JSON.stringify(body)
  })
}

async function postFinalize(org: string, sessionId: string, body: unknown, key: string) {
  return fetch(`${baseUrl}/v1/organizations/${org}/artifacts/uploads/${sessionId}:finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...AUTH_HEADER },
    body: JSON.stringify(body)
  })
}

async function publishPending(): Promise<void> {
  const claimed = await claimOutboxBatch(db, {
    workerId: 'artifact-test',
    batchSize: 100,
    leaseMs: 30_000
  })
  for (const event of claimed) {
    await publishClaimedEvent(db, event)
  }
}

beforeAll(async () => {
  try {
    pgHarness = await startPostgresHarness()
    s3Harness = await startObjectStorageHarness()
  } catch (error) {
    console.warn(`SKIPPED artifact vertical: Docker/Postgres/S3 unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: pgHarness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `art-${orgId.slice(0, 8)}`,
    displayName: 'Art Org'
  })
  storage = createObjectStorage(s3Harness)
  await storage.ensureBucket()
  registry = createContractSchemaRegistry()
  gateway = createRealtimeGateway({
    authorizeConnection: allowAllConnections(),
    db,
    registry,
    listenConnectionString: pgHarness.connectionString,
    heartbeatIntervalMs: 60_000,
    resyncWindow: 100
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: ARTIFACT_SUBJECT
  })
  app = buildApp({
    ping: async () => true,
    db,
    registry,
    gateway,
    objectStorage: storage,
    tokenVerifier: createTestTokenVerifier()
  })
  await app.ready()
  await gateway.start()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
  wsUrl = `ws://127.0.0.1:${address.port}/v1/realtime`
}, 240_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await pgHarness?.stop()
  await s3Harness?.stop()
})

describe('artifact upload vertical', () => {
  it('runs intent → presigned upload → finalize → realtime artifact.created', async (ctx) => {
    if (!pgHarness || !s3Harness) return ctx.skip()

    // Realtime client subscribed before the change.
    const ws = new WebSocket(wsUrl)
    const messages: Record<string, unknown>[] = []
    ws.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    ws.send(
      JSON.stringify({
        type: 'client.hello',
        schemaVersion: 1,
        protocolVersion: '1.0',
        instanceId: 'artifact-test',
        organizationId: orgId,
        lastCursor: null
      })
    )

    const intent = await postIntent(orgId, intentBody(), randomUUID())
    expect(intent.status).toBe(201)
    const intentJson = (await intent.json()) as {
      uploadSessionId: string
      uploadEndpoint: string
      artifact: { object: { objectId: string } }
    }
    const { uploadSessionId, uploadEndpoint } = intentJson
    const objectId = intentJson.artifact.object.objectId

    const put = await fetch(uploadEndpoint, {
      method: 'PUT',
      body: Buffer.alloc(SIZE_BYTES),
      headers: { 'content-type': 'application/pdf' }
    })
    expect(put.ok).toBe(true)

    const finalize = await postFinalize(
      orgId,
      uploadSessionId,
      { uploadSessionId, object: { objectId, sha256: SHA256, sizeBytes: SIZE_BYTES } },
      randomUUID()
    )
    expect(finalize.status).toBe(200)
    const artifact = (await finalize.json()) as { status: string; object: unknown }
    expect(artifact.status).toBe('available')
    expect(artifact.object).not.toBeNull()

    await publishPending()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no artifact realtime message')), 5000)
      const check = (): void => {
        if (messages.some((m) => m.type === 'resource.changed' && m.resourceType === 'artifact')) {
          clearTimeout(timer)
          resolve()
        }
      }
      ws.on('message', check)
      check()
    })
    ws.close()
  })

  it('rejects a local-path upload target', async (ctx) => {
    if (!pgHarness || !s3Harness) return ctx.skip()
    const response = await postIntent(
      orgId,
      intentBody({ localPath: '/private/project/report.pdf' }),
      randomUUID()
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code: string }).code).toBe('VALIDATION_FAILED')
  })

  it('is idempotent: same key+payload replays, different payload conflicts', async (ctx) => {
    if (!pgHarness || !s3Harness) return ctx.skip()
    const key = randomUUID()
    const body = intentBody({ name: 'idem.pdf' })
    const first = await postIntent(orgId, body, key)
    const second = await postIntent(orgId, body, key)
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    const firstJson = (await first.json()) as { uploadSessionId: string }
    const secondJson = (await second.json()) as { uploadSessionId: string }
    expect(firstJson.uploadSessionId).toBe(secondJson.uploadSessionId)

    const conflict = await postIntent(orgId, intentBody({ name: 'different.pdf' }), key)
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('cannot finalize one tenant’s session under another tenant', async (ctx) => {
    if (!pgHarness || !s3Harness) return ctx.skip()
    const otherOrg = randomUUID()
    await seedOrganizationFixture(db, {
      id: otherOrg,
      slug: `other-${otherOrg.slice(0, 8)}`,
      displayName: 'Other'
    })
    // The caller is a member of BOTH orgs, so RBAC passes for otherOrg — this
    // isolates the RLS boundary: the session belongs to orgId, so under otherOrg's
    // context RLS hides it and finalize is 404 (not an authorization 403).
    await seedMembershipFixture(db, {
      organizationId: otherOrg,
      issuer: TEST_ISSUER,
      subject: ARTIFACT_SUBJECT
    })
    const intent = await postIntent(orgId, intentBody({ name: 'private.pdf' }), randomUUID())
    const { uploadSessionId } = (await intent.json()) as { uploadSessionId: string }
    // Finalize under the OTHER org's path → RLS hides the session → 404.
    const finalize = await postFinalize(
      otherOrg,
      uploadSessionId,
      {
        uploadSessionId,
        object: { objectId: randomUUID(), sha256: SHA256, sizeBytes: SIZE_BYTES }
      },
      randomUUID()
    )
    expect(finalize.status).toBe(404)
  })
})
