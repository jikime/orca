import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  createTeam,
  listProjects,
  listWorkItems,
  parseCsvImport,
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
let teamId = ''
let assigneeUserId = ''
const ASSIGNEE_EMAIL = 'importee@test'

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

type PlanItem = { externalKey: string; kind: string; action: string; resourceId: string | null }
type ImportRunWire = {
  run: {
    id: string
    status: string
    createdCount: number
    updatedCount: number
    skippedCount: number
  }
  plan: { items: PlanItem[]; totals: { created: number; updated: number; skipped: number } }
}

function importPost(token: string, org: string, body: Record<string, unknown>): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${org}/imports`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

// 1 project + 2 work items, all carrying stable external keys — the same payload re-imports idempotently.
function samplePayload(
  dryRun: boolean,
  projectTitle = 'Imported Project'
): Record<string, unknown> {
  return {
    source: 'jira',
    dryRun,
    defaultTeamId: teamId,
    items: [
      { externalSystem: 'jira', externalKey: 'PROJ-1', kind: 'project', title: projectTitle },
      {
        externalSystem: 'jira',
        externalKey: 'PROJ-2',
        kind: 'work_item',
        title: 'Design the thing',
        assigneeEmail: ASSIGNEE_EMAIL
      },
      { externalSystem: 'jira', externalKey: 'PROJ-3', kind: 'work_item', title: 'Build the thing' }
    ]
  }
}

async function deliveryCounts(): Promise<{ projects: number; workItems: number }> {
  const projects = await listProjects(db, orgId)
  const workItems = await listWorkItems(db, orgId)
  return { projects: projects.length, workItems: workItems.length }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED import vertical: Docker unavailable — ${String(error)}`)
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
    slug: `imp-${orgId.slice(0, 8)}`,
    displayName: 'Import'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `imp2-${otherOrgId.slice(0, 8)}`,
    displayName: 'Import2'
  })
  // 'owner' has project.import.manage.
  const owner = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // 'member' lacks project.import.manage — used for the RBAC deny test.
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
  // An existing org user the import maps an assignee onto BY EMAIL (never created by the import).
  const assignee = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'importee',
    email: ASSIGNEE_EMAIL,
    roleIds: ['member']
  })
  assigneeUserId = assignee.userId
  const team = await createTeam(db, {
    organizationId: orgId,
    actorUserId: owner.userId,
    key: 'IMP',
    name: 'Import Team'
  })
  if (!team.ok) throw new Error('team seed failed')
  teamId = team.team.id
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('external import: dry-run + idempotent re-import vertical (R6 slice 6)', () => {
  it('(a) EXIT CONDITION: re-importing the SAME payload creates nothing new (0 created, N updated, counts unchanged)', async (ctx) => {
    if (!harness) return ctx.skip()
    const before = await deliveryCounts()
    // First real import: 1 project + 2 work items are created.
    const first = await jsonOf<ImportRunWire>(
      await importPost('owner', orgId, samplePayload(false))
    )
    expect(first.run.status).toBe('applied')
    expect(first.plan.totals).toEqual({ created: 3, updated: 0, skipped: 0 })
    const afterFirst = await deliveryCounts()
    expect(afterFirst.projects).toBe(before.projects + 1)
    expect(afterFirst.workItems).toBe(before.workItems + 2)

    // The assignee was mapped to the EXISTING org user by email — not a newly created user.
    const workItems = await listWorkItems(db, orgId)
    const designed = workItems.find((w) => w.title === 'Design the thing')
    expect(designed?.assigneeId).toBe(assigneeUserId)

    // Re-import the identical payload: NOTHING new is created, all three are updated in place.
    const second = await jsonOf<ImportRunWire>(
      await importPost('owner', orgId, samplePayload(false))
    )
    expect(second.plan.totals).toEqual({ created: 0, updated: 3, skipped: 0 })
    const afterSecond = await deliveryCounts()
    // The headline assertion: re-import did NOT duplicate the project or the work items.
    expect(afterSecond).toEqual(afterFirst)
  })

  it('(b) dry-run computes the plan but writes NO delivery resources', async (ctx) => {
    if (!harness) return ctx.skip()
    const before = await deliveryCounts()
    const res = await importPost('owner', orgId, {
      source: 'csv',
      dryRun: true,
      defaultTeamId: teamId,
      items: [
        {
          externalSystem: 'csv',
          externalKey: 'NEW-100',
          kind: 'project',
          title: 'Never Persisted'
        },
        {
          externalSystem: 'csv',
          externalKey: 'NEW-101',
          kind: 'work_item',
          title: 'Also not persisted'
        }
      ]
    })
    expect(res.status).toBe(200)
    const body = await jsonOf<ImportRunWire>(res)
    expect(body.run.status).toBe('planned')
    // Both are unlinked → planned as create, but nothing is written.
    expect(body.plan.totals).toEqual({ created: 2, updated: 0, skipped: 0 })
    expect(body.plan.items.every((i) => i.action === 'create')).toBe(true)
    expect(body.plan.items.every((i) => i.resourceId === null)).toBe(true)
    const after = await deliveryCounts()
    expect(after).toEqual(before)
  })

  it('(c) CSV text parses to normalized items (quoted field with an embedded comma)', (ctx) => {
    if (!harness) return ctx.skip()
    const csv = [
      'external_system,external_key,kind,title,assignee_email',
      'jira,CSV-1,project,"Alpha, Beta",',
      'jira,CSV-2,work_item,Gamma,dev@test'
    ].join('\n')
    const result = parseCsvImport(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({
      externalSystem: 'jira',
      externalKey: 'CSV-1',
      kind: 'project',
      title: 'Alpha, Beta'
    })
    expect(result.items[1]).toMatchObject({
      kind: 'work_item',
      title: 'Gamma',
      assigneeEmail: 'dev@test'
    })
  })

  it('(d) a changed title on re-import UPDATES the linked resource (not a duplicate)', async (ctx) => {
    if (!harness) return ctx.skip()
    const key = `RETITLE-${randomUUID().slice(0, 8)}`
    const create = await jsonOf<ImportRunWire>(
      await importPost('owner', orgId, {
        source: 'redmine',
        dryRun: false,
        items: [
          { externalSystem: 'redmine', externalKey: key, kind: 'project', title: 'Original Title' }
        ]
      })
    )
    const projectId = create.plan.items[0]?.resourceId
    expect(projectId).toBeTruthy()
    const beforeCount = (await listProjects(db, orgId)).length

    const update = await jsonOf<ImportRunWire>(
      await importPost('owner', orgId, {
        source: 'redmine',
        dryRun: false,
        items: [
          { externalSystem: 'redmine', externalKey: key, kind: 'project', title: 'Renamed Title' }
        ]
      })
    )
    expect(update.plan.totals).toEqual({ created: 0, updated: 1, skipped: 0 })
    expect(update.plan.items[0]?.resourceId).toBe(projectId)
    const projects = await listProjects(db, orgId)
    // Same count (no duplicate) and the SAME row now carries the new title.
    expect(projects.length).toBe(beforeCount)
    expect(projects.find((p) => p.id === projectId)?.name).toBe('Renamed Title')
  })

  it('(e) cross-tenant: another org owner cannot import into this org (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const denied = await importPost('other', orgId, samplePayload(true))
    expect(denied.status).toBe(403)
  })

  it('(f) RBAC: a member without project.import.manage cannot import (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const denied = await importPost('member', orgId, samplePayload(true))
    expect(denied.status).toBe(403)
  })
})
