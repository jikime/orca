import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { createTeam } from './team-store'
import { addWorkflowState, listTeamWorkflow, DEFAULT_WORKFLOW_STATES } from './workflow-store'
import { createWorkItem, getWorkItem, moveWorkItemState, updateWorkItem } from './work-item-store'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { seedEntitlementManifest } from './entitlement-manifest-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withoutTenantContext, withTenantTransaction } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

async function freshOrgWithTeam(
  key = 'APP'
): Promise<{ orgId: string; ownerId: string; teamId: string }> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, { id: orgId, slug: `w-${orgId.slice(0, 8)}`, displayName: 'W' })
  const { userId } = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: 'i',
    subject: `o-${orgId.slice(0, 8)}`
  })
  const team = await createTeam(db, { organizationId: orgId, actorUserId: userId, key, name: 'T' })
  return { orgId, ownerId: userId, teamId: team.ok ? team.team.id : '' }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED work-item suite: Docker/PostgreSQL unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
}, 180_000)

afterAll(async () => {
  await db?.destroy()
  await harness?.stop()
})

describe('delivery: team workflow', () => {
  it('seeds the default workflow when a team is created', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, teamId } = await freshOrgWithTeam()
    const workflow = await listTeamWorkflow(db, orgId, teamId)
    expect(workflow?.states.map((s) => s.key)).toEqual(DEFAULT_WORKFLOW_STATES.map((s) => s.key))
    expect(workflow?.workflowVersion).toBe(1)
  })

  it('bumps workflow_version on a state-set change', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId, teamId } = await freshOrgWithTeam()
    const added = await addWorkflowState(db, {
      organizationId: orgId,
      teamId,
      actorUserId: ownerId,
      key: 'blocked',
      name: 'Blocked',
      category: 'started',
      sortKey: 5
    })
    expect(added.ok).toBe(true)
    if (added.ok) expect(added.workflowVersion).toBe(2)
    const workflow = await listTeamWorkflow(db, orgId, teamId)
    expect(workflow?.workflowVersion).toBe(2)
    expect(workflow?.states.some((s) => s.key === 'blocked')).toBe(true)
  })
})

describe('delivery: work item identifier + counter', () => {
  it('assigns sequential team-scoped identifiers', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId, teamId } = await freshOrgWithTeam('APP')
    const first = await createWorkItem(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId,
      title: 'One'
    })
    const second = await createWorkItem(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId,
      title: 'Two'
    })
    expect(first.ok && first.workItem.identifier).toBe('APP-1')
    expect(second.ok && second.workItem.identifier).toBe('APP-2')
    // projectId null is allowed (team backlog).
    expect(first.ok && first.workItem.projectId).toBe(null)
  })

  it('gives each team its own key prefix + sequence', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId, teamId } = await freshOrgWithTeam('APP')
    const other = await createTeam(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      key: 'OPS',
      name: 'Ops'
    })
    const opsTeamId = other.ok ? other.team.id : ''
    const a = await createWorkItem(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId,
      title: 'A'
    })
    const b = await createWorkItem(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId: opsTeamId,
      title: 'B'
    })
    expect(a.ok && a.workItem.identifier).toBe('APP-1')
    expect(b.ok && b.workItem.identifier).toBe('OPS-1')
  })

  it('serializes two concurrent creates into distinct sequential identifiers', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId, teamId } = await freshOrgWithTeam('RACE')
    const [one, two] = await Promise.all([
      createWorkItem(db, { organizationId: orgId, actorUserId: ownerId, teamId, title: '1' }),
      createWorkItem(db, { organizationId: orgId, actorUserId: ownerId, teamId, title: '2' })
    ])
    const ids = [one, two].map((r) => (r.ok ? r.workItem.identifier : 'FAIL')).sort()
    expect(ids).toEqual(['RACE-1', 'RACE-2'])
  })
})

describe('delivery: work item update + move', () => {
  it('rejects an update with a stale expectedVersion', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId, teamId } = await freshOrgWithTeam()
    const created = await createWorkItem(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId,
      title: 'V1'
    })
    if (!created.ok) return
    const ok = await updateWorkItem(db, {
      organizationId: orgId,
      workItemId: created.workItem.id,
      actorUserId: ownerId,
      expectedVersion: 1,
      patch: { title: 'V2' }
    })
    expect(ok.ok && ok.workItem.version).toBe(2)
    const stale = await updateWorkItem(db, {
      organizationId: orgId,
      workItemId: created.workItem.id,
      actorUserId: ownerId,
      expectedVersion: 1,
      patch: { title: 'V3' }
    })
    expect(stale).toEqual({ ok: false, reason: 'version_conflict', currentVersion: 2 })
  })

  it('moves a work item and rejects stale/invalid moves without touching other rows', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId, teamId } = await freshOrgWithTeam()
    const workflow = await listTeamWorkflow(db, orgId, teamId)
    const todo = workflow!.states[0]!
    const inProgress = workflow!.states[1]!
    const created = await createWorkItem(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId,
      title: 'Move me'
    })
    if (!created.ok) return
    const wi = created.workItem
    expect(wi.stateId).toBe(todo.id)

    // Stale expectedVersion → conflict.
    const staleVersion = await moveWorkItemState(db, {
      organizationId: orgId,
      workItemId: wi.id,
      actorUserId: ownerId,
      fromStateId: todo.id,
      toStateId: inProgress.id,
      workflowVersion: 1,
      expectedVersion: 99
    })
    expect(staleVersion.ok).toBe(false)
    if (!staleVersion.ok) expect(staleVersion.reason).toBe('version_conflict')

    // Invalid toState (a foreign UUID not in the team workflow) → invalid_to_state.
    const invalid = await moveWorkItemState(db, {
      organizationId: orgId,
      workItemId: wi.id,
      actorUserId: ownerId,
      fromStateId: todo.id,
      toStateId: randomUUID(),
      workflowVersion: 1,
      expectedVersion: 1
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.reason).toBe('invalid_to_state')

    // Valid move → version bumps, state changes.
    const moved = await moveWorkItemState(db, {
      organizationId: orgId,
      workItemId: wi.id,
      actorUserId: ownerId,
      fromStateId: todo.id,
      toStateId: inProgress.id,
      workflowVersion: 1,
      expectedVersion: 1
    })
    expect(moved.ok && moved.workItem.stateId).toBe(inProgress.id)
    expect(moved.ok && moved.workItem.version).toBe(2)

    // A stale workflowVersion (team changed its states) → conflict.
    await addWorkflowState(db, {
      organizationId: orgId,
      teamId,
      actorUserId: ownerId,
      key: 'blocked',
      name: 'Blocked',
      category: 'started',
      sortKey: 5
    })
    const staleWorkflow = await moveWorkItemState(db, {
      organizationId: orgId,
      workItemId: wi.id,
      actorUserId: ownerId,
      fromStateId: inProgress.id,
      toStateId: todo.id,
      workflowVersion: 1,
      expectedVersion: 2
    })
    expect(staleWorkflow.ok).toBe(false)
    if (!staleWorkflow.ok) expect(staleWorkflow.reason).toBe('workflow_version_conflict')
  })

  it('blocks cross-tenant work item reads under RLS', async (ctx) => {
    if (!harness) return ctx.skip()
    const a = await freshOrgWithTeam('AAA')
    const b = await freshOrgWithTeam('BBB')
    const created = await createWorkItem(db, {
      organizationId: a.orgId,
      actorUserId: a.ownerId,
      teamId: a.teamId,
      title: 'Secret'
    })
    if (!created.ok) return
    // Same id, but read under org B's tenant context → RLS hides it.
    const seenFromB = await withTenantTransaction(db, b.orgId, (trx) =>
      trx
        .selectFrom('delivery.work_items')
        .select('id')
        .where('id', '=', created.workItem.id)
        .execute()
    )
    expect(seenFromB).toEqual([])
    // And the store's own org-scoped read from B returns null.
    expect(await getWorkItem(db, b.orgId, created.workItem.id)).toBe(null)
  })

  it('a move leaves the linked project row untouched (two-workflow separation)', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId, teamId } = await freshOrgWithTeam()
    // Create a project directly (no entitlement plan → unmetered) and link it.
    const projectId = randomUUID()
    await withoutTenantContext(db, async (trx) => {
      await trx
        .insertInto('delivery.projects')
        .values({ organization_id: orgId, id: projectId, name: 'Linked' })
        .execute()
    })
    const workflow = await listTeamWorkflow(db, orgId, teamId)
    const created = await createWorkItem(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId,
      projectId,
      title: 'On a project'
    })
    if (!created.ok) return
    const before = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('delivery.projects')
        .select('version')
        .where('id', '=', projectId)
        .executeTakeFirstOrThrow()
    )
    await moveWorkItemState(db, {
      organizationId: orgId,
      workItemId: created.workItem.id,
      actorUserId: ownerId,
      fromStateId: workflow!.states[0]!.id,
      toStateId: workflow!.states[1]!.id,
      workflowVersion: 1,
      expectedVersion: 1
    })
    const after = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('delivery.projects')
        .select('version')
        .where('id', '=', projectId)
        .executeTakeFirstOrThrow()
    )
    expect(Number(after.version)).toBe(Number(before.version))
  })
})
