import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { listMembershipsForMember } from './membership-query'
import { runMigrations } from './migration-runner'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED membership query suite: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
}, 180_000)

afterAll(async () => {
  await db?.destroy()
  await harness?.stop()
})

describe('membership query', () => {
  it('includes identity display names for roster consumers', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = '20000000-0000-4000-8000-000000000101'
    await seedOrganizationFixture(db, {
      id: orgId,
      slug: 'membership-labels',
      displayName: 'Membership Labels'
    })
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'https://issuer.test',
      subject: 'ada',
      displayName: 'Ada Lovelace'
    })

    const result = await listMembershipsForMember(
      db,
      {
        issuer: 'https://issuer.test',
        subject: 'ada',
        expiresAt: '2026-07-21T00:00:00.000Z'
      },
      orgId
    )

    expect(result.ok && result.items[0]?.displayName).toBe('Ada Lovelace')
  })
})
