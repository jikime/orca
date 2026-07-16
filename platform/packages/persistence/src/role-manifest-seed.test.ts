import { sql, Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { loadRoleManifestCatalog } from './role-manifest-catalog'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withoutTenantContext } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>
const catalog = loadRoleManifestCatalog()

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED role manifest seed: Docker/PostgreSQL unavailable — ${String(error)}`)
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

describe('role manifest seed', () => {
  it('seeds the manifest vocabulary and is idempotent by checksum', async (ctx) => {
    if (!harness) return ctx.skip()
    const first = await seedRoleManifest(db, catalog)
    expect(first.outcome).toBe('seeded')
    const second = await seedRoleManifest(db, catalog)
    expect(second.outcome).toBe('unchanged')
    expect(second.checksum).toBe(catalog.checksum)
  })

  it('materializes exactly the manifest roles and permissions (drift-detectable)', async (ctx) => {
    if (!harness) return ctx.skip()
    await seedRoleManifest(db, catalog)
    const rows = await withoutTenantContext(db, async (trx) => {
      const roles = await trx.selectFrom('identity.roles').select('id').execute()
      const permissions = await trx.selectFrom('identity.permissions').select('id').execute()
      const ownerPerms = await trx
        .selectFrom('identity.role_permissions')
        .select('permission_id')
        .where('role_id', '=', 'organization_owner')
        .execute()
      return { roles, permissions, ownerPerms }
    })
    expect(rows.roles.map((r) => r.id).sort()).toEqual(catalog.roles.map((r) => r.id).sort())
    expect(rows.permissions.map((p) => p.id).sort()).toEqual(
      catalog.permissions.map((p) => p.id).sort()
    )
    expect(rows.ownerPerms.map((p) => p.permission_id).sort()).toEqual(
      catalog.permissionsForRoles(['organization_owner'])
    )
  })

  it('re-seeds when the checksum differs, converging to the given catalog', async (ctx) => {
    if (!harness) return ctx.skip()
    // Simulate drift: record a stale checksum, then a seed of the real catalog
    // must re-materialize and record the true checksum.
    await withoutTenantContext(db, (trx) =>
      trx
        .updateTable('identity.role_manifest_seed')
        .set({ checksum: 'stale', seeded_at: sql`now()` })
        .where('id', '=', true)
        .execute()
    )
    const result = await seedRoleManifest(db, catalog)
    expect(result.outcome).toBe('seeded')
    expect(result.checksum).toBe(catalog.checksum)
  })
})
