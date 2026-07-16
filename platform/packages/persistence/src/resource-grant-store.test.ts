import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { evaluatePermission } from './permission-evaluator'
import { loadRoleManifestCatalog } from './role-manifest-catalog'
import { createResourceGrant, listResourceGrantsForUser } from './resource-grant-store'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>
const catalog = loadRoleManifestCatalog()

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED resource grant suite: Docker/PostgreSQL unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
}, 180_000)

afterAll(async () => {
  await db?.destroy()
  await harness?.stop()
})

// No R3 operation targets a real resource yet (projects/work-items are R4), so we
// exercise the grant store + evaluator against a SYNTHETIC resource op. R4's
// resource-scoped operations are its first real consumers.
describe('resource grant store + evaluator (synthetic resource op)', () => {
  it('a stored NARROW grant denies an operation the role would otherwise allow', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = randomUUID()
    await seedOrganizationFixture(db, {
      id: orgId,
      slug: `rg-${orgId.slice(0, 8)}`,
      displayName: 'RG'
    })
    const { userId } = await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `pm-${orgId.slice(0, 8)}`,
      roleIds: ['project_manager']
    })
    const resourceId = randomUUID()
    await createResourceGrant(db, {
      organizationId: orgId,
      userId,
      resourceType: 'project',
      resourceId,
      grantKind: 'narrow',
      permission: 'project.update'
    })
    const grants = await listResourceGrantsForUser(db, orgId, userId)
    const decision = evaluatePermission(
      {
        requiredPermission: 'project.update',
        requestedOrganizationId: orgId,
        membership: { organizationId: orgId, roleIds: ['project_manager'], status: 'active' },
        resource: { resourceType: 'project', resourceId },
        resourceGrants: grants
      },
      catalog
    )
    expect(decision).toEqual({ allowed: false, reason: 'resource_narrowed' })
  })

  it('a stored WIDEN grant allows an operation the role lacks', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = randomUUID()
    await seedOrganizationFixture(db, {
      id: orgId,
      slug: `rg2-${orgId.slice(0, 8)}`,
      displayName: 'RG2'
    })
    const { userId } = await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `mem-${orgId.slice(0, 8)}`,
      roleIds: ['member']
    })
    const resourceId = randomUUID()
    await createResourceGrant(db, {
      organizationId: orgId,
      userId,
      resourceType: 'project',
      resourceId,
      grantKind: 'widen',
      permission: 'project.archive'
    })
    const grants = await listResourceGrantsForUser(db, orgId, userId)
    const decision = evaluatePermission(
      {
        requiredPermission: 'project.archive',
        requestedOrganizationId: orgId,
        membership: { organizationId: orgId, roleIds: ['member'], status: 'active' },
        resource: { resourceType: 'project', resourceId },
        resourceGrants: grants
      },
      catalog
    )
    expect(decision).toEqual({ allowed: true, reason: 'allowed' })
  })
})
