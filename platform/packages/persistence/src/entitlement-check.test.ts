import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { checkMemberEntitlement } from './entitlement-check'
import { loadEntitlementManifestCatalog } from './entitlement-manifest-catalog'
import { seedEntitlementManifest } from './entitlement-manifest-seed'
import { acceptInvitation, createInvitation } from './invitation-store'
import {
  seedMembershipFixture,
  seedOrganizationFixture,
  seedSubscriptionFixture
} from './organization-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withoutTenantContext } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>
const catalog = loadEntitlementManifestCatalog()

async function orgOnPlan(plan: string | null): Promise<string> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `ent-${orgId.slice(0, 8)}`,
    displayName: 'Ent'
  })
  if (plan) {
    await seedSubscriptionFixture(db, { organizationId: orgId, planId: plan })
  }
  return orgId
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED entitlement suite: Docker/PostgreSQL unavailable — ${String(error)}`)
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

describe('member entitlement enforcement', () => {
  it('blocks a new member when the org is at its member limit (personal=1)', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await orgOnPlan('personal')
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `o-${orgId.slice(0, 8)}`
    })
    const decision = await checkMemberEntitlement(db, orgId)
    expect(decision).toEqual({ allowed: false, reason: 'entitlement_shortfall' })
  })

  it('allows a new member under a team plan (limit 50)', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await orgOnPlan('team')
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `t-${orgId.slice(0, 8)}`
    })
    expect((await checkMemberEntitlement(db, orgId)).allowed).toBe(true)
  })

  it('is unlimited on the enterprise plan (null limit)', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await orgOnPlan('enterprise')
    for (let i = 0; i < 3; i++) {
      await seedMembershipFixture(db, {
        organizationId: orgId,
        issuer: 'i',
        subject: `e${i}-${orgId.slice(0, 8)}`
      })
    }
    expect((await checkMemberEntitlement(db, orgId)).allowed).toBe(true)
  })

  it('is unmetered when the org has no subscription', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await orgOnPlan(null)
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `n-${orgId.slice(0, 8)}`
    })
    expect((await checkMemberEntitlement(db, orgId)).allowed).toBe(true)
  })

  it('invite acceptance at the member limit is an entitlement_shortfall (distinct audit)', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await orgOnPlan('personal')
    const { userId: adminId } = await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `adm-${orgId.slice(0, 8)}`
    })
    // Org is at the personal limit (1 = the admin). The invite acceptance is blocked
    // with a DISTINCT reason (not a permission denial) and a distinct audit code.
    const { rawToken } = await createInvitation(db, {
      organizationId: orgId,
      actorUserId: adminId,
      email: 'over-limit@test',
      userType: 'internal',
      roleIds: ['member']
    })
    const result = await acceptInvitation(
      db,
      {
        issuer: 'i2',
        subject: 'over-limit',
        email: 'over-limit@test',
        emailVerified: true,
        displayName: 'X'
      },
      rawToken
    )
    expect(result).toEqual({ ok: false, reason: 'entitlement_shortfall' })
    const audit = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.audit_events')
        .select('action')
        .where('organization_id', '=', orgId)
        .where('action', '=', 'entitlement.shortfall.core_members')
        .executeTakeFirst()
    )
    expect(audit).toBeDefined()
  })
})

describe('entitlement manifest seed', () => {
  it('is idempotent by checksum and materializes the plans', async (ctx) => {
    if (!harness) return ctx.skip()
    expect((await seedEntitlementManifest(db, catalog)).outcome).toBe('unchanged')
    const plans = await withoutTenantContext(db, (trx) =>
      trx.selectFrom('identity.entitlement_plans').select('id').execute()
    )
    expect(plans.map((p) => p.id).sort()).toEqual(catalog.plans.map((p) => p.id).sort())
  })
})
