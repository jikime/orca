import { randomUUID } from 'node:crypto'
import {
  createDatabase,
  createDatabasePool,
  runMigrations,
  seedOrganizationFixture,
  updateOrganizationDisplayName,
  withoutTenantContext,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOutboxClaimLoop } from './outbox-claim-loop'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase

const clock = { now: () => Date.now(), newId: () => randomUUID() }

function makeLoop(overrides: Partial<Parameters<typeof createOutboxClaimLoop>[0]> = {}) {
  return createOutboxClaimLoop({
    db,
    workerId: `test-${randomUUID().slice(0, 8)}`,
    batchSize: 16,
    leaseMs: 30_000,
    pollIntervalMs: 1_000,
    maxAttempts: 2,
    baseBackoffMs: 0,
    maxBackoffMs: 0,
    ...overrides
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED claim loop: Docker/PostgreSQL unavailable — ${String(error)}`)
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

describe('outbox claim loop', () => {
  it('publishes pending events in one pass', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = randomUUID()
    await seedOrganizationFixture(db, {
      id: orgId,
      slug: `l-${orgId.slice(0, 8)}`,
      displayName: 'Loop'
    })
    await updateOrganizationDisplayName(db, clock, {
      organizationId: orgId,
      displayName: 'Published'
    })

    const summary = await makeLoop().runOnce()
    expect(summary.published).toBeGreaterThanOrEqual(1)
  })

  it('parks a poison event after the retry budget across passes', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = randomUUID()
    await seedOrganizationFixture(db, {
      id: orgId,
      slug: `p-${orgId.slice(0, 8)}`,
      displayName: 'Poison'
    })
    const poisonId = randomUUID()
    await withoutTenantContext(db, (trx) =>
      trx
        .insertInto('operations.outbox_events')
        .values({
          id: poisonId,
          organization_id: orgId,
          aggregate_type: 'organization',
          aggregate_id: orgId,
          aggregate_version: 1,
          event_type: 'broken',
          event_schema_version: 1,
          payload: JSON.stringify({ not: 'an-envelope' })
        })
        .execute()
    )

    const loop = makeLoop()
    const first = await loop.runOnce()
    expect(first.requeued).toBeGreaterThanOrEqual(1)
    const second = await loop.runOnce()
    expect(second.parked).toBeGreaterThanOrEqual(1)

    // Parking relocates the row OUT of the hot outbox into the dead-letter store.
    const stillInOutbox = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('operations.outbox_events')
        .select('id')
        .where('id', '=', poisonId)
        .executeTakeFirst()
    )
    expect(stillInOutbox).toBeUndefined()

    const dead = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('operations.dead_letter_events')
        .select(['status', 'last_error_code', 'event_type'])
        .where('id', '=', poisonId)
        .executeTakeFirst()
    )
    expect(dead?.status).toBe('parked')
    expect(dead?.last_error_code).toBe('POISON_PAYLOAD')
    expect(dead?.event_type).toBe('broken')
  })
})
