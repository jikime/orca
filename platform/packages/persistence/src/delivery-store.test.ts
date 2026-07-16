import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { createProject, updateProject } from './project-store'
import { createTeam, DEFAULT_TEAM_KEY, listTeams } from './team-store'
import { provisionOwner } from './owner-provisioning'
import {
  seedMembershipFixture,
  seedOrganizationFixture,
  seedSubscriptionFixture
} from './organization-seed'
import { seedEntitlementManifest } from './entitlement-manifest-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withoutTenantContext, withTenantTransaction } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

async function freshOrgWithOwner(): Promise<{ orgId: string; ownerId: string }> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, { id: orgId, slug: `d-${orgId.slice(0, 8)}`, displayName: 'D' })
  const { userId } = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: 'i',
    subject: `o-${orgId.slice(0, 8)}`
  })
  return { orgId, ownerId: userId }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED delivery suite: Docker/PostgreSQL unavailable — ${String(error)}`)
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

describe('delivery: team', () => {
  it('provisions a default team when an owner org is created', async (ctx) => {
    if (!harness) return ctx.skip()
    const sub = {
      issuer: 'kc',
      subject: `prov-${randomUUID()}`,
      email: `${randomUUID()}@t`,
      emailVerified: true,
      displayName: 'P'
    }
    const result = await provisionOwner(db, { subject: sub })
    const teams = await listTeams(db, result.organizationId)
    expect(teams.map((t) => t.key)).toContain(DEFAULT_TEAM_KEY)
  })

  it('rejects a duplicate team key in the same org', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId } = await freshOrgWithOwner()
    expect(
      (
        await createTeam(db, {
          organizationId: orgId,
          actorUserId: ownerId,
          key: 'ALPHA',
          name: 'A'
        })
      ).ok
    ).toBe(true)
    expect(
      await createTeam(db, {
        organizationId: orgId,
        actorUserId: ownerId,
        key: 'ALPHA',
        name: 'A2'
      })
    ).toEqual({ ok: false, reason: 'key_taken' })
  })

  it('blocks cross-tenant team reads under RLS', async (ctx) => {
    if (!harness) return ctx.skip()
    const a = await freshOrgWithOwner()
    const b = await freshOrgWithOwner()
    await createTeam(db, {
      organizationId: a.orgId,
      actorUserId: a.ownerId,
      key: 'AONLY',
      name: 'A'
    })
    const seenFromB = await withTenantTransaction(db, b.orgId, (trx) =>
      trx.selectFrom('delivery.teams').select('key').where('key', '=', 'AONLY').execute()
    )
    expect(seenFromB).toEqual([])
  })
})

describe('delivery: project', () => {
  async function teamFor(orgId: string, ownerId: string): Promise<string> {
    const t = await createTeam(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      key: 'PRJ',
      name: 'P'
    })
    return t.ok ? t.team.id : ''
  }

  it('creates a project with a team link + audit + outbox project.created', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId } = await freshOrgWithOwner()
    const teamId = await teamFor(orgId, ownerId)
    const result = await createProject(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId,
      name: 'Apollo'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const rows = await withoutTenantContext(db, async (trx) => {
      const link = await trx
        .selectFrom('delivery.project_teams')
        .select('team_id')
        .where('project_id', '=', result.project.id)
        .executeTakeFirst()
      const outbox = await trx
        .selectFrom('operations.outbox_events')
        .select('event_type')
        .where('aggregate_id', '=', result.project.id)
        .executeTakeFirst()
      return { link, outbox }
    })
    expect(rows.link?.team_id).toBe(teamId)
    expect(rows.outbox?.event_type).toContain('project.created')
  })

  it('enforces core.projects with a distinct entitlement_shortfall', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId } = await freshOrgWithOwner()
    const teamId = await teamFor(orgId, ownerId)
    await seedSubscriptionFixture(db, { organizationId: orgId, planId: 'personal' }) // core.projects=10
    // Seed the org to its project limit directly.
    await withoutTenantContext(db, async (trx) => {
      for (let i = 0; i < 10; i++) {
        await trx
          .insertInto('delivery.projects')
          .values({ organization_id: orgId, name: `P${i}` })
          .execute()
      }
    })
    const result = await createProject(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId,
      name: 'Over'
    })
    expect(result).toEqual({ ok: false, reason: 'entitlement_shortfall' })
  })

  it('updates under If-Match and rejects a stale version', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, ownerId } = await freshOrgWithOwner()
    const teamId = await teamFor(orgId, ownerId)
    const created = await createProject(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      teamId,
      name: 'V1'
    })
    if (!created.ok) return
    const ok = await updateProject(db, {
      organizationId: orgId,
      projectId: created.project.id,
      actorUserId: ownerId,
      expectedVersion: 1,
      patch: { name: 'V2' }
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.project.version).toBe(2)
    const stale = await updateProject(db, {
      organizationId: orgId,
      projectId: created.project.id,
      actorUserId: ownerId,
      expectedVersion: 1,
      patch: { name: 'V3' }
    })
    expect(stale).toEqual({ ok: false, reason: 'version_conflict', currentVersion: 2 })
  })
})
