import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { EmailNotVerifiedError, provisionOwner, type VerifiedSubject } from './owner-provisioning'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withoutTenantContext } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

function subject(overrides: Partial<VerifiedSubject> = {}): VerifiedSubject {
  const id = randomUUID()
  return {
    issuer: 'https://issuer.test/realms/pie',
    subject: `sub-${id}`,
    email: `${id}@test`,
    emailVerified: true,
    displayName: 'Owner',
    ...overrides
  }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED owner provisioning: Docker/PostgreSQL unavailable — ${String(error)}`)
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

describe('owner provisioning', () => {
  it('creates the account, org and owner membership on first provision', async (ctx) => {
    if (!harness) return ctx.skip()
    const result = await provisionOwner(db, { subject: subject() })
    expect(result.created).toBe(true)
    const membership = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('identity.memberships')
        .select(['status', 'role_ids'])
        .where('id', '=', result.membershipId)
        .executeTakeFirstOrThrow()
    )
    expect(membership.status).toBe('active')
    expect(membership.role_ids).toEqual(['organization_owner'])
  })

  it('is idempotent: re-provisioning the same subject returns the existing org', async (ctx) => {
    if (!harness) return ctx.skip()
    const sub = subject()
    const first = await provisionOwner(db, { subject: sub })
    const second = await provisionOwner(db, { subject: sub })
    expect(second.created).toBe(false)
    expect(second.organizationId).toBe(first.organizationId)
    expect(second.userId).toBe(first.userId)
    const orgCount = await withoutTenantContext(db, async (trx) => {
      const rows = await trx
        .selectFrom('identity.memberships')
        .select('id')
        .where('user_id', '=', first.userId)
        .execute()
      return rows.length
    })
    expect(orgCount).toBe(1)
  })

  it('rejects an unverified subject and writes no partial rows', async (ctx) => {
    if (!harness) return ctx.skip()
    const sub = subject({ emailVerified: false })
    await expect(provisionOwner(db, { subject: sub })).rejects.toBeInstanceOf(EmailNotVerifiedError)
    const account = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('identity.user_accounts')
        .select('id')
        .where('subject', '=', sub.subject)
        .executeTakeFirst()
    )
    expect(account).toBeUndefined()
  })
})
