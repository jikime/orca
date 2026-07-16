import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { listMigrationFiles, runMigrations, type MigrationResult } from './migration-runner'
import { seedOrganizationFixture } from './organization-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import {
  withoutTenantContext,
  withTenantTransaction,
  withWorkerClaimTransaction
} from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>
let initialMigration: MigrationResult

const ORG_A = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a'
const ORG_B = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b'

async function insertOutboxRow(orgId: string): Promise<string> {
  const id = randomUUID()
  await withoutTenantContext(db, async (trx) => {
    await trx
      .insertInto('operations.outbox_events')
      .values({
        id,
        organization_id: orgId,
        aggregate_type: 'organization',
        aggregate_id: orgId,
        aggregate_version: 1,
        event_type: 'organization.created',
        event_schema_version: 1,
        payload: JSON.stringify({ organizationId: orgId })
      })
      .execute()
  })
  return id
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    // Explicit, non-green skip signal (never fake a pass).
    console.warn(
      `SKIPPED persistence integration tests: Docker/PostgreSQL unavailable — ${String(error)}`
    )
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  initialMigration = await runMigrations(pool)
  await seedOrganizationFixture(db, {
    id: ORG_A,
    slug: 'org-a',
    displayName: 'Org A'
  })
  await seedOrganizationFixture(db, {
    id: ORG_B,
    slug: 'org-b',
    displayName: 'Org B'
  })
}, 180_000)

afterAll(async () => {
  await db?.destroy()
  await harness?.stop()
})

describe('migration runner', () => {
  it('applies every migration from an empty database', (ctx) => {
    if (!harness) return ctx.skip()
    expect(initialMigration.applied).toEqual(listMigrationFiles().map((file) => file.name))
    expect(initialMigration.skipped).toEqual([])
  })

  it('is idempotent — a second run skips all applied migrations', async (ctx) => {
    if (!harness) return ctx.skip()
    const second = await runMigrations(pool)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(listMigrationFiles().map((file) => file.name))
  })

  it('rejects a changed checksum of an already-applied migration', async (ctx) => {
    if (!harness) return ctx.skip()
    const appliedName = listMigrationFiles()[0]!.name
    const tamperedDir = mkdtempSync(join(tmpdir(), 'pie-migration-freeze-'))
    writeFileSync(join(tamperedDir, appliedName), '-- tampered content\nselect 1;\n', 'utf-8')
    await expect(runMigrations(pool, { dir: tamperedDir })).rejects.toThrow(/frozen migration/i)
  })
})

describe('tenant RLS (pie_app)', () => {
  it('sees only its own organization row', async (ctx) => {
    if (!harness) return ctx.skip()
    const rows = await withTenantTransaction(db, ORG_A, (trx) =>
      trx.selectFrom('identity.organizations').select('id').execute()
    )
    expect(rows.map((row) => row.id)).toEqual([ORG_A])
  })

  it('cannot read another tenant row even when it asks for it by id', async (ctx) => {
    if (!harness) return ctx.skip()
    const rows = await withTenantTransaction(db, ORG_A, (trx) =>
      trx.selectFrom('identity.organizations').select('id').where('id', '=', ORG_B).execute()
    )
    expect(rows).toEqual([])
  })

  it('cannot write a row belonging to another tenant', async (ctx) => {
    if (!harness) return ctx.skip()
    await expect(
      withTenantTransaction(db, ORG_A, (trx) =>
        trx
          .insertInto('operations.outbox_events')
          .values({
            id: randomUUID(),
            organization_id: ORG_B,
            aggregate_type: 'organization',
            aggregate_id: ORG_B,
            aggregate_version: 1,
            event_type: 'organization.created',
            event_schema_version: 1,
            payload: JSON.stringify({})
          })
          .execute()
      )
    ).rejects.toThrow(/row-level security/i)
  })

  it('default-denies with no tenant context', async (ctx) => {
    if (!harness) return ctx.skip()
    const rows = await db.transaction().execute(async (trx) => {
      await sql`set local role pie_app`.execute(trx)
      return trx.selectFrom('identity.organizations').selectAll().execute()
    })
    expect(rows).toEqual([])
  })
})

describe('worker outbox claim (pie_worker)', () => {
  it('claims outbox rows across tenants but cannot touch audit or organizations', async (ctx) => {
    if (!harness) return ctx.skip()
    const outboxA = await insertOutboxRow(ORG_A)
    const outboxB = await insertOutboxRow(ORG_B)

    const claimed = await withWorkerClaimTransaction(db, async (trx) => {
      const rows = await trx
        .selectFrom('operations.outbox_events')
        .select('id')
        .where('published_at', 'is', null)
        .execute()
      await trx
        .updateTable('operations.outbox_events')
        .set({ claimed_by: 'worker-test' })
        .where('id', 'in', [outboxA, outboxB])
        .execute()
      return rows.map((row) => row.id)
    })
    expect(claimed).toEqual(expect.arrayContaining([outboxA, outboxB]))

    await expect(
      withWorkerClaimTransaction(db, (trx) =>
        trx.selectFrom('audit.audit_events').selectAll().execute()
      )
    ).rejects.toThrow(/permission denied/i)
    await expect(
      withWorkerClaimTransaction(db, (trx) =>
        trx.selectFrom('identity.organizations').selectAll().execute()
      )
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('organization seed loader', () => {
  it('is idempotent — a repeated seed inserts nothing the second time', async (ctx) => {
    if (!harness) return ctx.skip()
    const org = {
      id: randomUUID(),
      slug: `seed-${randomUUID().slice(0, 8)}`,
      displayName: 'Seed Org'
    }
    const first = await seedOrganizationFixture(db, org)
    const second = await seedOrganizationFixture(db, org)
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
  })
})
