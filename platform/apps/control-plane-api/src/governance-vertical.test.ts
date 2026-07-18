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

function transition(
  kind: string,
  prefix: string,
  id: string,
  action: string,
  version: number,
  token = 'owner'
): Promise<Response> {
  return bearerFetch(token, org(`/${kind}/${id}:transition`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID(), 'if-match': `"${prefix}-${version}"` },
    body: JSON.stringify({ action })
  })
}

async function createRisk(
  projectId: string,
  body: Record<string, unknown>,
  token = 'owner'
): Promise<Response> {
  return bearerFetch(token, org(`/projects/${projectId}/risks`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

async function createDecision(
  projectId: string,
  body: Record<string, unknown>
): Promise<Versioned & { supersedesId: string | null; decidedBy: string | null }> {
  const res = await bearerFetch('owner', org(`/projects/${projectId}/decisions`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
  expect(res.status).toBe(201)
  return jsonOf(res)
}

async function createStatusReport(
  projectId: string,
  body: Record<string, unknown>
): Promise<Versioned & { periodEnd: string; overallStatus: string }> {
  const res = await bearerFetch('owner', org(`/projects/${projectId}/status-reports`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
  expect(res.status).toBe(201)
  return jsonOf(res)
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED governance vertical: Docker unavailable — ${String(error)}`)
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
    slug: `gov-${orgId.slice(0, 8)}`,
    displayName: 'Gov'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `gov2-${otherOrgId.slice(0, 8)}`,
    displayName: 'Gov2'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // 'member' has project.governance.read but NOT project.governance.manage — used for the create deny.
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

describe('governance vertical (R6 project risks + decisions + status reports)', () => {
  it('(a) RISK: probability=high × impact=high ⇒ severity critical (computed on write)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const res = await createRisk(projectId, {
      title: 'Vendor API may miss the deadline',
      category: 'external',
      probability: 'high',
      impact: 'high'
    })
    expect(res.status).toBe(201)
    const risk = await jsonOf<{ severity: string; status: string; probability: string }>(res)
    expect(risk.severity).toBe('critical')
    expect(risk.status).toBe('open')

    // A low × low risk lands at severity low — proves the matrix, not a constant.
    const low = await createRisk(projectId, {
      title: 'Minor typo',
      probability: 'low',
      impact: 'low'
    })
    expect((await jsonOf<{ severity: string }>(low)).severity).toBe('low')
  })

  it('(b) RISK status :transition open → mitigating → closed under OCC (428 / 409 / 200)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const created = await jsonOf<Versioned>(
      await createRisk(projectId, { title: 'Scope creep', probability: 'medium', impact: 'high' })
    )
    const mitigating = await jsonOf<Versioned>(
      await transition('risks', 'project-risk', created.id, 'mitigate', created.version)
    )
    expect(mitigating.status).toBe('mitigating')
    // Missing If-Match → 428.
    const noIfMatch = await bearerFetch('owner', org(`/risks/${created.id}:transition`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ action: 'close' })
    })
    expect(noIfMatch.status).toBe(428)
    // Stale version → 409.
    const stale = await transition('risks', 'project-risk', created.id, 'close', created.version)
    expect(stale.status).toBe(409)
    // Correct version → 200 closed.
    const closed = await transition(
      'risks',
      'project-risk',
      created.id,
      'close',
      mitigating.version
    )
    expect(closed.status).toBe(200)
    expect((await jsonOf<Versioned>(closed)).status).toBe('closed')
  })

  it('(c) DECISION log: create + list-by-project; a superseding decision references the prior', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const first = await createDecision(projectId, {
      title: 'Adopt Postgres',
      context: 'Need a relational store',
      decision: 'Use Postgres 16',
      rationale: 'Team familiarity'
    })
    expect(first.decidedBy).toBeTruthy()
    expect(first.supersedesId).toBeNull()
    const second = await createDecision(projectId, {
      title: 'Revisit datastore',
      decision: 'Add a read replica',
      supersedesId: first.id
    })
    expect(second.supersedesId).toBe(first.id)

    const listed = await jsonOf<{ items: { id: string; supersedesId: string | null }[] }>(
      await bearerFetch('owner', org(`/projects/${projectId}/decisions`))
    )
    const ids = listed.items.map((d) => d.id)
    expect(ids).toContain(first.id)
    expect(ids).toContain(second.id)
  })

  it('(d) STATUS report: create green/amber/red + list-by-project ordered by period (desc)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    await createStatusReport(projectId, {
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      overallStatus: 'green',
      summary: 'Q1 on track'
    })
    await createStatusReport(projectId, {
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
      overallStatus: 'red',
      summary: 'Q3 blocked'
    })
    const amber = await createStatusReport(projectId, {
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
      overallStatus: 'amber',
      summary: 'Q2 at risk'
    })
    expect(amber.overallStatus).toBe('amber')

    const listed = await jsonOf<{ items: { periodEnd: string; overallStatus: string }[] }>(
      await bearerFetch('owner', org(`/projects/${projectId}/status-reports`))
    )
    expect(listed.items.map((r) => r.periodEnd)).toEqual(['2026-09-30', '2026-06-30', '2026-03-31'])
    expect(listed.items[0]?.overallStatus).toBe('red')
  })

  it('(e) SUMMARY: open risks by severity + latest status report + recent decisions', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    await createRisk(projectId, { title: 'Critical', probability: 'high', impact: 'high' })
    await createDecision(projectId, { title: 'Kickoff', decision: 'Start now' })
    await createStatusReport(projectId, {
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      overallStatus: 'green',
      summary: 'Kickoff done'
    })
    const summary = await jsonOf<{
      openRiskCount: number
      openRisksBySeverity: { critical: number }
      latestStatusReport: { overallStatus: string } | null
      recentDecisions: { id: string }[]
    }>(await bearerFetch('owner', org(`/projects/${projectId}/governance`)))
    expect(summary.openRiskCount).toBe(1)
    expect(summary.openRisksBySeverity.critical).toBe(1)
    expect(summary.latestStatusReport?.overallStatus).toBe('green')
    expect(summary.recentDecisions.length).toBe(1)
  })

  it('(f) RBAC: a member without project.governance.manage cannot create a risk (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const denied = await createRisk(projectId, { title: 'x' }, 'member')
    expect(denied.status).toBe(403)
  })

  it('(g) cross-tenant: another org owner cannot read this org risk (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const risk = await jsonOf<Versioned>(await createRisk(projectId, { title: 'Isolated' }))
    const denied = await bearerFetch('other', org(`/risks/${risk.id}`))
    expect(denied.status).toBe(403)
  })
})
