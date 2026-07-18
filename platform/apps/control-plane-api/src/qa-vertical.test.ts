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

function org(suffix: string): string {
  return `/v1/organizations/${orgId}${suffix}`
}

type Versioned = { id: string; version: number; status: string }

// Creates a real requirement (via its own route) so the qa-traceability read — which verifies the
// requirement exists — has a genuine requirement_id to trace from.
async function createRequirement(projectId: string): Promise<string> {
  const res = await bearerFetch('owner', org('/requirements'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ projectId, code: `REQ-${randomUUID().slice(0, 8)}`, title: 'Login' })
  })
  expect(res.status).toBe(201)
  return (await jsonOf<{ id: string }>(res)).id
}

async function createDeliverable(
  token: string,
  projectId: string,
  requirementId?: string
): Promise<Versioned> {
  const res = await bearerFetch(token, org(`/projects/${projectId}/deliverables`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      name: 'Design doc',
      description: 'Architecture deliverable',
      ...(requirementId ? { requirementId } : {}),
      dueDate: '2026-09-01'
    })
  })
  expect(res.status).toBe(201)
  return jsonOf<Versioned>(res)
}

async function createTestCase(requirementId: string): Promise<Versioned> {
  const res = await bearerFetch('owner', org('/test-cases'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      title: 'Login succeeds',
      steps: 'enter creds',
      expected: 'dashboard',
      requirementId
    })
  })
  expect(res.status).toBe(201)
  return jsonOf<Versioned>(res)
}

async function createDefect(projectId: string, links: Record<string, string>): Promise<Versioned> {
  const res = await bearerFetch('owner', org(`/projects/${projectId}/defects`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ title: 'Login 500', severity: 'high', ...links })
  })
  expect(res.status).toBe(201)
  return jsonOf<Versioned>(res)
}

function transition(
  kind: string,
  id: string,
  action: string,
  version: number,
  token = 'owner'
): Promise<Response> {
  return bearerFetch(token, org(`/${kind}/${id}:transition`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID(), 'if-match': `"${kind.slice(0, -1)}-${version}"` },
    body: JSON.stringify({ action })
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED qa vertical: Docker unavailable — ${String(error)}`)
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
    slug: `qa-${orgId.slice(0, 8)}`,
    displayName: 'Qa'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `qa2-${otherOrgId.slice(0, 8)}`,
    displayName: 'Qa2'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // 'member' has project.qa.read but NOT project.qa.manage — used for the create RBAC deny.
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

describe('qa vertical (R6 deliverables + test cases + defects + traceability)', () => {
  it('(a) TRACEABILITY: a requirement traces to its deliverable + test case + defect', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const requirementId = await createRequirement(projectId)
    const deliverable = await createDeliverable('owner', projectId, requirementId)
    const testCase = await createTestCase(requirementId)
    const defect = await createDefect(projectId, { testCaseId: testCase.id })

    const res = await bearerFetch('owner', org(`/requirements/${requirementId}/qa-traceability`))
    expect(res.status).toBe(200)
    const trace = await jsonOf<{
      requirementId: string
      deliverables: { id: string }[]
      testCases: { id: string }[]
      defects: { id: string }[]
      coverage: { hasDeliverable: boolean; hasTestCase: boolean; defectCount: number }
    }>(res)
    expect(trace.requirementId).toBe(requirementId)
    expect(trace.deliverables.map((d) => d.id)).toEqual([deliverable.id])
    expect(trace.testCases.map((t) => t.id)).toEqual([testCase.id])
    expect(trace.defects.map((d) => d.id)).toEqual([defect.id])
    expect(trace.coverage.hasDeliverable).toBe(true)
    expect(trace.coverage.hasTestCase).toBe(true)
    expect(trace.coverage.defectCount).toBe(1)
  })

  it('(b) deliverable accept :transition under OCC (428 / 409 / 200)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const d0 = await createDeliverable('owner', projectId)
    const started = await jsonOf<Versioned>(
      await transition('deliverables', d0.id, 'start', d0.version)
    )
    const submitted = await jsonOf<Versioned>(
      await transition('deliverables', d0.id, 'submit', started.version)
    )
    expect(submitted.status).toBe('submitted')
    // Missing If-Match → 428.
    const noIfMatch = await bearerFetch('owner', org(`/deliverables/${d0.id}:transition`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ action: 'accept' })
    })
    expect(noIfMatch.status).toBe(428)
    // Stale version → 409.
    const stale = await transition('deliverables', d0.id, 'accept', d0.version)
    expect(stale.status).toBe(409)
    // Correct version → 200 accepted.
    const accepted = await transition('deliverables', d0.id, 'accept', submitted.version)
    expect(accepted.status).toBe(200)
    expect((await jsonOf<Versioned>(accepted)).status).toBe('accepted')
  })

  it('(c) defect status :transition open → resolved under OCC', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const defect = await createDefect(projectId, {})
    expect(defect.status).toBe('open')
    // Stale version → 409.
    const stale = await transition('defects', defect.id, 'resolve', defect.version + 5)
    expect(stale.status).toBe(409)
    const resolved = await transition('defects', defect.id, 'resolve', defect.version)
    expect(resolved.status).toBe(200)
    expect((await jsonOf<Versioned>(resolved)).status).toBe('resolved')
  })

  it('(d) test case pass/fail :transition', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const requirementId = await createRequirement(projectId)
    const tc = await createTestCase(requirementId)
    expect(tc.status).toBe('draft')
    const ready = await jsonOf<Versioned>(
      await transition('test-cases', tc.id, 'ready', tc.version)
    )
    expect(ready.status).toBe('ready')
    const passed = await jsonOf<Versioned>(
      await transition('test-cases', tc.id, 'pass', ready.version)
    )
    expect(passed.status).toBe('passed')
    // A passed test can be re-run to failed.
    const failed = await jsonOf<Versioned>(
      await transition('test-cases', tc.id, 'fail', passed.version)
    )
    expect(failed.status).toBe('failed')
  })

  it('(e) RBAC: a member without project.qa.manage cannot create a deliverable (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const denied = await bearerFetch('member', org(`/projects/${projectId}/deliverables`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'x' })
    })
    expect(denied.status).toBe(403)
  })

  it('(f) cross-tenant: another org owner cannot read this org deliverable (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const deliverable = await createDeliverable('owner', projectId)
    const denied = await bearerFetch('other', org(`/deliverables/${deliverable.id}`))
    expect(denied.status).toBe(403)
  })
})
