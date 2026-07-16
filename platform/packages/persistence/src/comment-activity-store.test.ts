import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { createTeam } from './team-store'
import { listTeamWorkflow } from './workflow-store'
import {
  assignWorkItem,
  createWorkItem,
  listWorkItemActivity,
  moveWorkItemState
} from './work-item-store'
import { createComment, listComments } from './comment-store'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { seedEntitlementManifest } from './entitlement-manifest-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withTenantTransaction } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

async function freshOrgTeamItem(): Promise<{
  orgId: string
  ownerId: string
  teamId: string
  workItemId: string
}> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, { id: orgId, slug: `c-${orgId.slice(0, 8)}`, displayName: 'C' })
  const { userId } = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: 'i',
    subject: `o-${orgId.slice(0, 8)}`
  })
  const team = await createTeam(db, {
    organizationId: orgId,
    actorUserId: userId,
    key: 'APP',
    name: 'T'
  })
  const teamId = team.ok ? team.team.id : ''
  const item = await createWorkItem(db, {
    organizationId: orgId,
    actorUserId: userId,
    teamId,
    title: 'WI'
  })
  return { orgId, ownerId: userId, teamId, workItemId: item.ok ? item.workItem.id : '' }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED comment/activity suite: Docker unavailable — ${String(error)}`)
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

describe('delivery: comments', () => {
  it('creates and lists a comment', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId, workItemId } = await freshOrgTeamItem()
    const created = await createComment(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      workItemId,
      body: 'First comment'
    })
    expect(created.ok).toBe(true)
    const list = await listComments(db, orgId, workItemId)
    expect(list.map((c) => c.body)).toEqual(['First comment'])
    expect(list[0]!.visibility).toBe('project')
  })

  it('rejects a comment on a missing work item', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId } = await freshOrgTeamItem()
    const result = await createComment(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      workItemId: randomUUID(),
      body: 'nope'
    })
    expect(result).toEqual({ ok: false, reason: 'work_item_not_found' })
  })

  it('blocks cross-tenant comment reads under RLS', async (ctx) => {
    if (!harness) return ctx.skip()
    const a = await freshOrgTeamItem()
    const b = await freshOrgTeamItem()
    await createComment(db, {
      organizationId: a.orgId,
      actorUserId: a.ownerId,
      workItemId: a.workItemId,
      body: 'secret'
    })
    const seenFromB = await withTenantTransaction(db, b.orgId, (trx) =>
      trx.selectFrom('delivery.comments').select('body').where('body', '=', 'secret').execute()
    )
    expect(seenFromB).toEqual([])
  })
})

describe('delivery: activity timeline', () => {
  it('includes create, move, assign, and comment for the work item only', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId, teamId, workItemId } = await freshOrgTeamItem()
    const workflow = await listTeamWorkflow(db, orgId, teamId)
    await moveWorkItemState(db, {
      organizationId: orgId,
      workItemId,
      actorUserId: ownerId,
      fromStateId: workflow!.states[0]!.id,
      toStateId: workflow!.states[1]!.id,
      workflowVersion: 1,
      expectedVersion: 1
    })
    await assignWorkItem(db, {
      organizationId: orgId,
      workItemId,
      actorUserId: ownerId,
      assigneeId: ownerId,
      expectedVersion: 2
    })
    await createComment(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      workItemId,
      body: 'note'
    })
    // A second work item's activity must not appear.
    const other = await createWorkItem(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId,
      title: 'Other'
    })
    const activity = await listWorkItemActivity(db, orgId, workItemId)
    const actions = activity.map((a) => a.action)
    expect(actions).toContain('work_item.created')
    expect(actions).toContain('work_item.state_moved')
    expect(actions).toContain('work_item.assigned')
    expect(actions).toContain('work_item.commented')
    expect(activity.every((a) => a.workItemId === workItemId)).toBe(true)
    if (other.ok) expect(actions).not.toContain(`created-${other.workItem.id}`)
  })
})

describe('delivery: assignment', () => {
  it('assigns under version and rejects a stale version', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId, workItemId } = await freshOrgTeamItem()
    const ok = await assignWorkItem(db, {
      organizationId: orgId,
      workItemId,
      actorUserId: ownerId,
      assigneeId: ownerId,
      expectedVersion: 1
    })
    expect(ok.ok && ok.workItem.assigneeId).toBe(ownerId)
    expect(ok.ok && ok.workItem.version).toBe(2)
    const stale = await assignWorkItem(db, {
      organizationId: orgId,
      workItemId,
      actorUserId: ownerId,
      assigneeId: null,
      expectedVersion: 1
    })
    expect(stale).toEqual({ ok: false, reason: 'version_conflict', currentVersion: 2 })
  })
})
