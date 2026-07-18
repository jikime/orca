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

type AssignmentWire = { id: string; userId: string; allocationPct: string; version: number }
type EffortEntryWire = { id: string; effortHours: string }
type UserUtilizationWire = {
  userId: string
  summedAllocationPct: string
  overAllocated: boolean
  plannedEffortHours: string | null
  plannedManMonths: string | null
  actualEffortHours: string | null
  actualManMonths: string | null
}
type UtilizationWire = { hoursPerManMonth: number; users: UserUtilizationWire[] }
type NodeVarianceWire = {
  wbsNodeId: string
  plannedEffortHours: string | null
  actualEffortHours: string | null
  varianceHours: string
  variancePct: string | null
  plannedManMonths: string | null
  actualManMonths: string | null
}
type VarianceWire = { nodes: NodeVarianceWire[]; totals: { varianceHours: string } }
type WbsNodeWire = { id: string; version: number }

async function createAssignment(
  token: string,
  projectId: string,
  body: Record<string, unknown>
): Promise<Response> {
  return bearerFetch(token, plan(orgId, projectId, '/resource-assignments'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

async function logEffort(
  projectId: string,
  body: Record<string, unknown>
): Promise<EffortEntryWire> {
  const res = await bearerFetch('owner', plan(orgId, projectId, '/effort-entries'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
  expect(res.status).toBe(201)
  return jsonOf<EffortEntryWire>(res)
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
    console.warn(`SKIPPED planning-resource vertical: Docker unavailable — ${String(error)}`)
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
    slug: `res-${orgId.slice(0, 8)}`,
    displayName: 'Resource'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `res2-${otherOrgId.slice(0, 8)}`,
    displayName: 'Resource2'
  })
  // 'owner' has project.resource.read + project.resource.manage.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // 'member' has project.resource.read only — used for the RBAC deny test.
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

describe('planning / resource allocation + planned-vs-actual vertical (R6 slice 5)', () => {
  it('(a) over-allocation: two overlapping 60% assignments sum to 120% and flag overAllocated', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const busyUser = randomUUID()
    const calmUser = randomUUID()
    // busyUser: 60% + 60% both overlapping the query window → over-allocated (intentionally allowed).
    const a1 = await createAssignment('owner', projectId, {
      userId: busyUser,
      allocationPct: 60,
      startDate: '2026-01-01',
      endDate: '2026-06-30'
    })
    expect(a1.status).toBe(201)
    const a2 = await createAssignment('owner', projectId, {
      userId: busyUser,
      allocationPct: 60,
      startDate: '2026-03-01',
      endDate: '2026-09-30'
    })
    expect(a2.status).toBe(201)
    // calmUser: a single 50% assignment → not over-allocated.
    const a3 = await createAssignment('owner', projectId, {
      userId: calmUser,
      allocationPct: 50,
      startDate: '2026-01-01',
      endDate: '2026-12-31'
    })
    expect(a3.status).toBe(201)

    const util = await jsonOf<UtilizationWire>(
      await bearerFetch(
        'owner',
        plan(orgId, projectId, '/utilization?from=2026-04-01&to=2026-04-30')
      )
    )
    const busy = util.users.find((u) => u.userId === busyUser)
    const calm = util.users.find((u) => u.userId === calmUser)
    expect(busy?.summedAllocationPct).toBe('120.00')
    expect(busy?.overAllocated).toBe(true)
    expect(calm?.summedAllocationPct).toBe('50.00')
    expect(calm?.overAllocated).toBe(false)
  })

  it('(b) a non-overlapping window is not flagged even for the same person', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const userId = randomUUID()
    // Two 60% bookings that do NOT overlap each other; a window inside only one sees just 60%.
    await createAssignment('owner', projectId, {
      userId,
      allocationPct: 60,
      startDate: '2026-01-01',
      endDate: '2026-01-31'
    })
    await createAssignment('owner', projectId, {
      userId,
      allocationPct: 60,
      startDate: '2026-03-01',
      endDate: '2026-03-31'
    })
    const util = await jsonOf<UtilizationWire>(
      await bearerFetch(
        'owner',
        plan(orgId, projectId, '/utilization?from=2026-01-10&to=2026-01-20')
      )
    )
    const row = util.users.find((u) => u.userId === userId)
    expect(row?.summedAllocationPct).toBe('60.00')
    expect(row?.overAllocated).toBe(false)
  })

  it('(c) man-month rollup: effort hours ÷ 160 (utilization + variance both use 160)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const userId = randomUUID()
    // 320 planned hours = 2.00 MM; 160 actual logged hours = 1.00 MM.
    await createAssignment('owner', projectId, {
      userId,
      allocationPct: 100,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      plannedEffortHours: 320
    })
    await logEffort(projectId, { userId, entryDate: '2026-04-05', effortHours: 100 })
    await logEffort(projectId, { userId, entryDate: '2026-04-06', effortHours: 60 })
    const util = await jsonOf<UtilizationWire>(
      await bearerFetch(
        'owner',
        plan(orgId, projectId, '/utilization?from=2026-01-01&to=2026-12-31')
      )
    )
    expect(util.hoursPerManMonth).toBe(160)
    const row = util.users.find((u) => u.userId === userId)
    expect(row?.plannedEffortHours).toBe('320.00')
    expect(row?.plannedManMonths).toBe('2.00')
    expect(row?.actualEffortHours).toBe('160.00')
    expect(row?.actualManMonths).toBe('1.00')
  })

  it('(d) VARIANCE: planned=baseline snapshot, actual=sum(entries); editing the live node after capture does not move planned', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const userId = randomUUID()
    // A leaf WBS node with 320 planned hours.
    const node = await createNode(projectId, {
      wbsCode: '1',
      name: 'Build',
      nodeType: 'task',
      plannedStart: '2026-01-01',
      plannedEnd: '2026-03-31',
      plannedEffortHours: 320
    })
    // Capture the baseline — freezes planned_effort_hours=320 for this node.
    const captured = await bearerFetch('owner', plan(orgId, projectId, '/schedule-baselines'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'Kickoff' })
    })
    expect(captured.status).toBe(201)
    const baselineId = (await jsonOf<{ baseline: { id: string } }>(captured)).baseline.id

    // Log 100 + 60 = 160 ACTUAL hours against the node.
    await logEffort(projectId, {
      userId,
      wbsNodeId: node.id,
      entryDate: '2026-02-01',
      effortHours: 100
    })
    await logEffort(projectId, {
      userId,
      wbsNodeId: node.id,
      entryDate: '2026-02-15',
      effortHours: 60
    })

    // Now EDIT the live node's planned effort AFTER capture — must not move the planned side.
    const edited = await bearerFetch('owner', plan(orgId, projectId, `/wbs/${node.id}:update`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"wbs-node-${node.version}"` },
      body: JSON.stringify({ plannedEffortHours: 999 })
    })
    expect(edited.status).toBe(200)

    const variance = await jsonOf<VarianceWire>(
      await bearerFetch(
        'owner',
        plan(orgId, projectId, `/schedule-baselines/${baselineId}/variance`)
      )
    )
    const nodeVar = variance.nodes.find((n) => n.wbsNodeId === node.id)
    // PLANNED is the frozen baseline snapshot (320), NOT the edited live value (999).
    expect(nodeVar?.plannedEffortHours).toBe('320.00')
    expect(nodeVar?.actualEffortHours).toBe('160.00')
    expect(nodeVar?.varianceHours).toBe('-160.00')
    expect(nodeVar?.variancePct).toBe('-50.00')
    expect(nodeVar?.plannedManMonths).toBe('2.00')
    expect(nodeVar?.actualManMonths).toBe('1.00')
    expect(variance.totals.varianceHours).toBe('-160.00')
  })

  it('(e) update assignment under OCC (200 / 409 / 428) and invalid allocation is rejected (422)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const userId = randomUUID()
    const created = await jsonOf<AssignmentWire>(
      await createAssignment('owner', projectId, {
        userId,
        allocationPct: 40,
        startDate: '2026-01-01',
        endDate: '2026-06-30'
      })
    )
    const path = plan(orgId, projectId, `/resource-assignments/${created.id}:update`)
    const ok = await bearerFetch('owner', path, {
      method: 'POST',
      headers: {
        'idempotency-key': randomUUID(),
        'if-match': `"resource-assignment-${created.version}"`
      },
      body: JSON.stringify({ allocationPct: 80 })
    })
    expect(ok.status).toBe(200)
    expect((await jsonOf<AssignmentWire>(ok)).allocationPct).toBe('80.00')
    // Stale version → 409.
    const stale = await bearerFetch('owner', path, {
      method: 'POST',
      headers: {
        'idempotency-key': randomUUID(),
        'if-match': `"resource-assignment-${created.version}"`
      },
      body: JSON.stringify({ allocationPct: 90 })
    })
    expect(stale.status).toBe(409)
    // Missing If-Match → 428.
    const noIfMatch = await bearerFetch('owner', path, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ allocationPct: 90 })
    })
    expect(noIfMatch.status).toBe(428)
    // Negative allocation at create → 422.
    const bad = await createAssignment('owner', projectId, {
      userId,
      allocationPct: -5,
      startDate: '2026-01-01',
      endDate: '2026-06-30'
    })
    expect(bad.status).toBe(422)
  })

  it('(f) cross-tenant: another org owner cannot read this org utilization (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    await createAssignment('owner', projectId, {
      userId: randomUUID(),
      allocationPct: 50,
      startDate: '2026-01-01',
      endDate: '2026-06-30'
    })
    const denied = await bearerFetch(
      'other',
      plan(orgId, projectId, '/utilization?from=2026-01-01&to=2026-06-30')
    )
    expect(denied.status).toBe(403)
    // And the other org sees none of this org's assignments in its own (empty) list.
    const empty = await jsonOf<{ items: AssignmentWire[] }>(
      await bearerFetch('other', plan(otherOrgId, projectId, '/resource-assignments'))
    )
    expect(empty.items).toHaveLength(0)
  })

  it('(g) RBAC: a member without project.resource.manage cannot create an assignment (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const denied = await createAssignment('member', projectId, {
      userId: randomUUID(),
      allocationPct: 50,
      startDate: '2026-01-01',
      endDate: '2026-06-30'
    })
    expect(denied.status).toBe(403)
    // But the member CAN read utilization (project.resource.read).
    const allowed = await bearerFetch(
      'member',
      plan(orgId, projectId, '/utilization?from=2026-01-01&to=2026-06-30')
    )
    expect(allowed.status).toBe(200)
  })
})
