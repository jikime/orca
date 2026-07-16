import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
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
let ownerId = ''
let teamId = ''
let todoStateId = ''
let inProgressStateId = ''

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

const owner = (path: string, init?: RequestInit) => bearerFetch('owner', path, init)

async function jsonOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

async function createItem(title: string): Promise<{ id: string }> {
  return jsonOf<{ id: string }>(
    await owner(`/v1/organizations/${orgId}/work-items`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ teamId, title })
    })
  )
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED my-work vertical: Docker unavailable — ${String(error)}`)
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
    slug: `mw-${orgId.slice(0, 8)}`,
    displayName: 'MW'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  // A plain member (has work_item.update, NOT work_item.assign) and an external
  // customer role (sees only customer-visible comments).
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'customer',
    roleIds: ['customer_approver']
  })
  const team = await jsonOf<{ id: string }>(
    await owner(`/v1/organizations/${orgId}/teams`, {
      method: 'POST',
      body: JSON.stringify({ key: 'CORE', name: 'Core' })
    })
  )
  teamId = team.id
  const workflow = await jsonOf<{ items: Array<{ id: string; key: string }> }>(
    await owner(`/v1/organizations/${orgId}/teams/${teamId}/workflow-states`)
  )
  todoStateId = workflow.items.find((s) => s.key === 'todo')!.id
  inProgressStateId = workflow.items.find((s) => s.key === 'in_progress')!.id
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('My Work', () => {
  it("returns only the caller's assigned items for assignee=me, no cross-user leak", async (ctx) => {
    if (!harness) return ctx.skip()
    const mine = await createItem('Mine')
    const notMine = await createItem('Not mine')
    await owner(`/v1/organizations/${orgId}/work-items/${mine.id}:assign`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ assigneeId: ownerId, expectedVersion: 1 })
    })
    const list = await jsonOf<{ items: Array<{ id: string }> }>(
      await owner(`/v1/organizations/${orgId}/work-items?assignee=me`)
    )
    const ids = list.items.map((i) => i.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(notMine.id)
  })
})

describe('assignment', () => {
  it('a member without work_item.assign is denied (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const item = await createItem('Assign me')
    const denied = await bearerFetch(
      'member',
      `/v1/organizations/${orgId}/work-items/${item.id}:assign`,
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
        body: JSON.stringify({ assigneeId: ownerId, expectedVersion: 1 })
      }
    )
    expect(denied.status).toBe(403)
  })

  it('a PATCH that changes assignee is rejected → use :assign (409)', async (ctx) => {
    if (!harness) return ctx.skip()
    const item = await createItem('Patch assignee')
    const patched = await owner(`/v1/organizations/${orgId}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'if-match': '"work-item-1"', 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ assigneeId: ownerId })
    })
    expect(patched.status).toBe(409)
  })
})

describe('comments + activity', () => {
  it('creates a comment, delivers a realtime invalidation, and lists it', async (ctx) => {
    if (!harness) return ctx.skip()
    const item = await createItem('Discuss')
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
        instanceId: 'mw-test',
        organizationId: orgId,
        lastCursor: null
      })
    )
    await delay(250)
    const created = await owner(`/v1/organizations/${orgId}/work-items/${item.id}/comments`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ body: 'Ready for review', visibility: 'project' })
    })
    expect(created.status).toBe(201)
    await createOutboxClaimLoop({
      db,
      workerId: 'mw-w',
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
    const list = await jsonOf<{ items: Array<{ body: string }> }>(
      await owner(`/v1/organizations/${orgId}/work-items/${item.id}/comments`)
    )
    expect(list.items.some((c) => c.body === 'Ready for review')).toBe(true)
  })

  it('an external customer role sees only customer-visible comments (TEN-004)', async (ctx) => {
    if (!harness) return ctx.skip()
    const item = await createItem('Mixed visibility')
    for (const [body, visibility] of [
      ['internal secret', 'internal'],
      ['team note', 'project'],
      ['for the customer', 'customer']
    ] as const) {
      await owner(`/v1/organizations/${orgId}/work-items/${item.id}/comments`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ body, visibility })
      })
    }
    const asCustomer = await jsonOf<{ items: Array<{ body: string; visibility: string }> }>(
      await bearerFetch('customer', `/v1/organizations/${orgId}/work-items/${item.id}/comments`)
    )
    expect(asCustomer.items.map((c) => c.body)).toEqual(['for the customer'])
    const asOwner = await jsonOf<{ items: Array<unknown> }>(
      await owner(`/v1/organizations/${orgId}/work-items/${item.id}/comments`)
    )
    expect(asOwner.items.length).toBe(3)
  })

  it('exposes the work item Activity history (move + comment)', async (ctx) => {
    if (!harness) return ctx.skip()
    const item = await createItem('Trackable')
    await owner(`/v1/organizations/${orgId}/work-items/${item.id}:move-state`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        fromStateId: todoStateId,
        toStateId: inProgressStateId,
        workflowVersion: 1,
        expectedVersion: 1
      })
    })
    await owner(`/v1/organizations/${orgId}/work-items/${item.id}/comments`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ body: 'moved it' })
    })
    const activity = await jsonOf<{ items: Array<{ action: string }> }>(
      await owner(`/v1/organizations/${orgId}/work-items/${item.id}/activity`)
    )
    const actions = activity.items.map((a) => a.action)
    expect(actions).toContain('work_item.created')
    expect(actions).toContain('work_item.state_moved')
    expect(actions).toContain('work_item.commented')
  })
})
