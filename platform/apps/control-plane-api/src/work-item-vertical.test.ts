import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  createResourceGrant,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedEntitlementManifest,
  withoutTenantContext,
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
let ownerId = ''
let teamId = ''
let todoStateId = ''
let inProgressStateId = ''

function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer owner',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  })
}

async function jsonOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED work-item vertical: Docker unavailable — ${String(error)}`)
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
    slug: `wv-${orgId.slice(0, 8)}`,
    displayName: 'WV'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  const team = await jsonOf<{ id: string }>(
    await authFetch(`/v1/organizations/${orgId}/teams`, {
      method: 'POST',
      body: JSON.stringify({ key: 'CORE', name: 'Core' })
    })
  )
  teamId = team.id
  const workflow = await jsonOf<{ items: Array<{ id: string; key: string }> }>(
    await authFetch(`/v1/organizations/${orgId}/teams/${teamId}/workflow-states`)
  )
  todoStateId = workflow.items.find((s) => s.key === 'todo')!.id
  inProgressStateId = workflow.items.find((s) => s.key === 'in_progress')!.id
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

async function createItem(title: string): Promise<{ id: string }> {
  return jsonOf<{ id: string }>(
    await authFetch(`/v1/organizations/${orgId}/work-items`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ teamId, title })
    })
  )
}

describe('WorkItem vertical', () => {
  it('lists a seeded workflow and its version', async (ctx) => {
    if (!harness) return ctx.skip()
    const r = await authFetch(`/v1/organizations/${orgId}/teams/${teamId}/workflow-states`)
    const body = await jsonOf<{ items: unknown[]; workflowVersion: number }>(r)
    expect(r.status).toBe(200)
    expect(body.items.length).toBe(4)
    expect(body.workflowVersion).toBe(1)
  })

  it('creates a work item and delivers work_item.created to a realtime subscriber', async (ctx) => {
    if (!harness) return ctx.skip()
    const changes: Array<{ resourceType?: string }> = []
    const socket = new WebSocket(wsUrl, { headers: { authorization: 'Bearer owner' } })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
    })
    socket.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString()) as { type?: string; resourceType?: string }
      if (m.type === 'resource.changed') changes.push(m)
    })
    socket.send(
      JSON.stringify({
        type: 'client.hello',
        schemaVersion: 1,
        protocolVersion: '1.0',
        instanceId: 'wi-test',
        organizationId: orgId,
        lastCursor: null
      })
    )
    await delay(250)
    const create = await authFetch(`/v1/organizations/${orgId}/work-items`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ teamId, title: 'Realtime item' })
    })
    expect(create.status).toBe(201)
    expect(create.headers.get('etag')).toBe('"work-item-1"')
    expect(create.headers.get('location')).toContain('/work-items/')
    const created = await jsonOf<{ identifier: string }>(create)
    expect(created.identifier).toBe('CORE-1')
    await createOutboxClaimLoop({
      db,
      workerId: 'wi-w',
      batchSize: 10,
      leaseMs: 30_000,
      pollIntervalMs: 1000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0
    }).runOnce()
    for (let i = 0; i < 60 && !changes.some((c) => c.resourceType === 'work_item'); i++)
      await delay(50)
    expect(changes.some((c) => c.resourceType === 'work_item')).toBe(true)
    socket.close()
  })

  it('moves a work item via :move-state and 412s a stale workflowVersion', async (ctx) => {
    if (!harness) return ctx.skip()
    const item = await createItem('Board move')
    const move = await authFetch(`/v1/organizations/${orgId}/work-items/${item.id}:move-state`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        fromStateId: todoStateId,
        toStateId: inProgressStateId,
        workflowVersion: 1,
        expectedVersion: 1
      })
    })
    expect(move.status).toBe(200)
    expect(move.headers.get('etag')).toBe('"work-item-2"')
    // A stale workflowVersion is rejected 412.
    const stale = await authFetch(`/v1/organizations/${orgId}/work-items/${item.id}:move-state`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        fromStateId: inProgressStateId,
        toStateId: todoStateId,
        workflowVersion: 999,
        expectedVersion: 2
      })
    })
    expect(stale.status).toBe(412)
  })

  it('rejects a move to a state outside the workflow with 422', async (ctx) => {
    if (!harness) return ctx.skip()
    const item = await createItem('Bad target')
    const bad = await authFetch(`/v1/organizations/${orgId}/work-items/${item.id}:move-state`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        fromStateId: todoStateId,
        toStateId: randomUUID(),
        workflowVersion: 1,
        expectedVersion: 1
      })
    })
    expect(bad.status).toBe(422)
  })

  it('updates under If-Match and returns 412 on a stale ETag', async (ctx) => {
    if (!harness) return ctx.skip()
    const item = await createItem('Editable')
    const ok = await authFetch(`/v1/organizations/${orgId}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'if-match': '"work-item-1"', 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ title: 'Edited' })
    })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('etag')).toBe('"work-item-2"')
    const stale = await authFetch(`/v1/organizations/${orgId}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'if-match': '"work-item-1"', 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ title: 'Again' })
    })
    expect(stale.status).toBe(412)
  })

  it('a per-work-item NARROW grant denies getWorkItem even though the role grants work_item.read', async (ctx) => {
    if (!harness) return ctx.skip()
    const item = await createItem('Guarded')
    await createResourceGrant(db, {
      organizationId: orgId,
      userId: ownerId,
      resourceType: 'work_item',
      resourceId: item.id,
      grantKind: 'narrow',
      permission: 'work_item.read'
    })
    const denied = await authFetch(`/v1/organizations/${orgId}/work-items/${item.id}`)
    expect(denied.status).toBe(403)
    const audit = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.authorization_denials')
        .select('reason')
        .where('subject', '=', 'owner')
        .where('reason', '=', 'resource_narrowed')
        .executeTakeFirst()
    )
    expect(audit?.reason).toBe('resource_narrowed')
  })
})
