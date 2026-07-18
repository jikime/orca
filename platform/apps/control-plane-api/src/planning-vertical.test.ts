import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
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
let otherOrgId = ''

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

function plan(org: string, projectId: string, suffix: string): string {
  return `/v1/organizations/${org}/projects/${projectId}${suffix}`
}

type WbsNodeWire = {
  id: string
  parentId: string | null
  wbsCode: string
  nodeType: string
  status: string
  plannedStart: string | null
  plannedEnd: string | null
  plannedEffortHours: string | null
  version: number
}
type WbsRollup = {
  plannedStart: string | null
  plannedEnd: string | null
  plannedEffortHours: string | null
}
type WbsTreeNodeWire = WbsNodeWire & { rollup: WbsRollup; children: WbsTreeNodeWire[] }
type MilestoneWire = { id: string; status: string; targetDate: string; version: number }
type BaselineEntryWire = {
  wbsNodeId: string
  wbsCode: string
  plannedStart: string | null
  plannedEnd: string | null
  plannedEffortHours: string | null
}
type BaselineDetailWire = {
  baseline: { id: string; entryCount: number }
  entries: BaselineEntryWire[]
}

async function createNode(projectId: string, body: Record<string, unknown>): Promise<WbsNodeWire> {
  const res = await bearerFetch('owner', plan(orgId, projectId, '/wbs'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
  expect(res.status).toBe(201)
  return jsonOf<WbsNodeWire>(res)
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED planning vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  app = buildApp({ ping: async () => true, db, registry, tokenVerifier: createTestTokenVerifier() })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  otherOrgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `plan-${orgId.slice(0, 8)}`,
    displayName: 'Planning'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `plan2-${otherOrgId.slice(0, 8)}`,
    displayName: 'Planning2'
  })
  // 'owner' has project.plan.read + project.plan.manage.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // 'member' has project.plan.read only — used for the RBAC deny test.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
  // 'other' owns a DIFFERENT org — used for cross-tenant isolation.
  await seedMembershipFixture(db, {
    organizationId: otherOrgId,
    issuer: TEST_ISSUER,
    subject: 'other',
    roleIds: ['organization_owner']
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('planning / WBS + milestones + baselines vertical (R6 slice 4)', () => {
  it('(a) tree read rolls a summary up: start=min, end=max, effort=sum of children', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const root = await createNode(projectId, {
      wbsCode: '1',
      name: 'Root',
      nodeType: 'summary'
    })
    await createNode(projectId, {
      parentId: root.id,
      wbsCode: '1.1',
      name: 'Analysis',
      nodeType: 'task',
      plannedStart: '2026-01-01',
      plannedEnd: '2026-01-10',
      plannedEffortHours: '8.00'
    })
    await createNode(projectId, {
      parentId: root.id,
      wbsCode: '1.2',
      name: 'Build',
      nodeType: 'task',
      plannedStart: '2026-01-05',
      plannedEnd: '2026-01-20',
      plannedEffortHours: '12.00'
    })
    const tree = await jsonOf<{ items: WbsTreeNodeWire[] }>(
      await bearerFetch('owner', plan(orgId, projectId, '/wbs'))
    )
    expect(tree.items).toHaveLength(1)
    const rootNode = tree.items[0]
    expect(rootNode?.children).toHaveLength(2)
    // The summary stored no dates/effort itself; they are rolled up from the subtree on read.
    expect(rootNode?.plannedStart).toBeNull()
    expect(rootNode?.rollup.plannedStart).toBe('2026-01-01')
    expect(rootNode?.rollup.plannedEnd).toBe('2026-01-20')
    expect(rootNode?.rollup.plannedEffortHours).toBe('20.00')
  })

  it('(b) a cycle-creating move is rejected (409 WBS_CYCLE)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const root = await createNode(projectId, { wbsCode: '1', name: 'Root', nodeType: 'summary' })
    const child = await createNode(projectId, {
      parentId: root.id,
      wbsCode: '1.1',
      name: 'Child',
      nodeType: 'task'
    })
    // Moving the root UNDER its own descendant would form a cycle → refused.
    const cyclic = await bearerFetch('owner', plan(orgId, projectId, `/wbs/${root.id}:move`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"wbs-node-${root.version}"` },
      body: JSON.stringify({ parentId: child.id })
    })
    expect(cyclic.status).toBe(409)
    expect((await jsonOf<{ code: string }>(cyclic)).code).toBe('WBS_CYCLE')
    // A legal move (child → root, reorder) still succeeds under OCC.
    const ok = await bearerFetch('owner', plan(orgId, projectId, `/wbs/${child.id}:move`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"wbs-node-${child.version}"` },
      body: JSON.stringify({ parentId: null, sortOrder: 5 })
    })
    expect(ok.status).toBe(200)
    expect((await jsonOf<WbsNodeWire>(ok)).parentId).toBeNull()
  })

  it('(c) milestone create + met/missed transition with OCC (200 / 409 / 428)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const created = await bearerFetch('owner', plan(orgId, projectId, '/milestones'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'Go-live', targetDate: '2026-03-01' })
    })
    expect(created.status).toBe(201)
    const milestone = await jsonOf<MilestoneWire>(created)
    expect(milestone.status).toBe('planned')
    expect(milestone.targetDate).toBe('2026-03-01')
    const path = plan(orgId, projectId, `/milestones/${milestone.id}:transition`)
    const met = await bearerFetch('owner', path, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"milestone-${milestone.version}"` },
      body: JSON.stringify({ toStatus: 'met' })
    })
    expect(met.status).toBe(200)
    expect((await jsonOf<MilestoneWire>(met)).status).toBe('met')
    // Stale version → 409.
    const stale = await bearerFetch('owner', path, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"milestone-${milestone.version}"` },
      body: JSON.stringify({ toStatus: 'missed' })
    })
    expect(stale.status).toBe(409)
    // Missing If-Match → 428.
    const noIfMatch = await bearerFetch('owner', path, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ toStatus: 'missed' })
    })
    expect(noIfMatch.status).toBe(428)
  })

  it('(d) BASELINE IMMUTABILITY: editing a node does not alter a captured baseline entry', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const root = await createNode(projectId, { wbsCode: '1', name: 'Root', nodeType: 'summary' })
    const child = await createNode(projectId, {
      parentId: root.id,
      wbsCode: '1.1',
      name: 'Task',
      nodeType: 'task',
      plannedStart: '2026-01-01',
      plannedEnd: '2026-01-10',
      plannedEffortHours: '8.00'
    })
    // Capture the baseline — an immutable snapshot of the CURRENT planned schedule.
    const captured = await bearerFetch('owner', plan(orgId, projectId, '/schedule-baselines'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'Kickoff baseline' })
    })
    expect(captured.status).toBe(201)
    const detail = await jsonOf<BaselineDetailWire>(captured)
    expect(detail.baseline.entryCount).toBe(2)
    const baselineId = detail.baseline.id
    const snapshotEntry = detail.entries.find((e) => e.wbsCode === '1.1')
    expect(snapshotEntry?.plannedEnd).toBe('2026-01-10')

    // Now EDIT the live node's planned_end.
    const edited = await bearerFetch('owner', plan(orgId, projectId, `/wbs/${child.id}:update`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"wbs-node-${child.version}"` },
      body: JSON.stringify({ plannedEnd: '2026-02-28' })
    })
    expect(edited.status).toBe(200)
    expect((await jsonOf<WbsNodeWire>(edited)).plannedEnd).toBe('2026-02-28')

    // The baseline entry is UNCHANGED — the frozen reference the variance slice compares against.
    const after = await jsonOf<BaselineDetailWire>(
      await bearerFetch('owner', plan(orgId, projectId, `/schedule-baselines/${baselineId}`))
    )
    const afterEntry = after.entries.find((e) => e.wbsCode === '1.1')
    expect(afterEntry?.plannedEnd).toBe('2026-01-10')
    // And the LIVE tree reflects the edit — proving the two are decoupled.
    const tree = await jsonOf<{ items: WbsTreeNodeWire[] }>(
      await bearerFetch('owner', plan(orgId, projectId, '/wbs'))
    )
    const liveChild = tree.items[0]?.children.find((c) => c.wbsCode === '1.1')
    expect(liveChild?.plannedEnd).toBe('2026-02-28')
  })

  it('(e) cross-tenant: another org owner cannot read this org WBS (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    await createNode(projectId, { wbsCode: '1', name: 'Root', nodeType: 'summary' })
    const denied = await bearerFetch('other', plan(orgId, projectId, '/wbs'))
    expect(denied.status).toBe(403)
  })

  it('(f) RBAC: a member without project.plan.manage cannot create a WBS node (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const denied = await bearerFetch('member', plan(orgId, projectId, '/wbs'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ wbsCode: '1', name: 'Nope', nodeType: 'summary' })
    })
    expect(denied.status).toBe(403)
  })
})
