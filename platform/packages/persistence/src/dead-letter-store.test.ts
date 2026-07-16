import { randomUUID } from 'node:crypto'
import { Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { updateOrganizationDisplayName } from './organization-mutation'
import { seedOrganizationFixture } from './organization-seed'
import { claimOutboxBatch, requeueFailedEvent } from './outbox-publish'
import { collectDeadLetterMetrics, requeueDeadLetterEvent } from './dead-letter-store'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withoutTenantContext, withTenantTransaction } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

const clock = { now: () => Date.now(), newId: () => randomUUID() }

async function freshOrg(): Promise<string> {
  const id = randomUUID()
  await seedOrganizationFixture(db, { id, slug: `dl-${id.slice(0, 8)}`, displayName: 'DL Org' })
  return id
}

// Enqueue one outbox event for the org and immediately dead-letter it (retry
// budget of 1 → the first failure parks). Returns the dead-lettered event id.
async function parkFreshEvent(orgId: string): Promise<string> {
  await updateOrganizationDisplayName(db, clock, { organizationId: orgId, displayName: 'renamed' })
  const claimed = await claimOutboxBatch(db, {
    workerId: 'dl-test',
    batchSize: 50,
    leaseMs: 30_000
  })
  const mine = claimed.find((event) => event.organizationId === orgId)
  if (!mine) {
    throw new Error('expected to claim the freshly enqueued event')
  }
  await requeueFailedEvent(db, mine, 'FORCED_PARK', {
    maxAttempts: 1,
    baseBackoffMs: 0,
    maxBackoffMs: 0
  })
  return mine.id
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED dead-letter store: Docker/PostgreSQL unavailable — ${String(error)}`)
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

describe('dead-letter relocation', () => {
  it('moves a parked event out of the hot outbox with a complete record', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const eventId = await parkFreshEvent(orgId)

    const inOutbox = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('operations.outbox_events')
        .select('id')
        .where('id', '=', eventId)
        .executeTakeFirst()
    )
    expect(inOutbox).toBeUndefined()

    const dead = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('operations.dead_letter_events')
        .selectAll()
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow()
    )
    expect(dead.organization_id).toBe(orgId)
    expect(dead.status).toBe('parked')
    expect(dead.last_error_code).toBe('FORCED_PARK')
    expect(dead.aggregate_type).toBe('organization')
    expect(dead.event_type).toBe('ai.pielab.organization.updated.v1')
    expect(Number(dead.attempt_count)).toBe(1)
  })
})

describe('operator requeue', () => {
  it('moves a dead letter back onto the outbox and records an audit trail', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const eventId = await parkFreshEvent(orgId)

    const result = await requeueDeadLetterEvent(db, eventId, 'operator@test')
    expect(result).toEqual({ outcome: 'requeued', organizationId: orgId })

    const requeued = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('operations.outbox_events')
        .select(['published_at', 'attempt_count'])
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow()
    )
    expect(requeued.published_at).toBeNull()
    expect(Number(requeued.attempt_count)).toBe(0)

    const dead = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('operations.dead_letter_events')
        .select(['status', 'requeue_count', 'requeued_by'])
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow()
    )
    expect(dead.status).toBe('requeued')
    expect(Number(dead.requeue_count)).toBe(1)
    expect(dead.requeued_by).toBe('operator@test')

    const audit = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.audit_events')
        .select('id')
        .where('action', '=', 'outbox.dead_letter.requeued')
        .where('target_id', '=', eventId)
        .executeTakeFirst()
    )
    expect(audit).toBeDefined()
  })

  it('is a no-op on a dead letter that is already requeued', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const eventId = await parkFreshEvent(orgId)
    await requeueDeadLetterEvent(db, eventId)
    const second = await requeueDeadLetterEvent(db, eventId)
    expect(second).toEqual({ outcome: 'not_found' })
  })
})

describe('dead-letter metrics', () => {
  it('counts active (parked) dead letters and excludes requeued ones', async (ctx) => {
    if (!harness) return ctx.skip()
    const before = await collectDeadLetterMetrics(db)
    const orgId = await freshOrg()
    const eventId = await parkFreshEvent(orgId)
    const afterPark = await collectDeadLetterMetrics(db)
    expect(afterPark.parked).toBe(before.parked + 1)
    await requeueDeadLetterEvent(db, eventId)
    const afterRequeue = await collectDeadLetterMetrics(db)
    expect(afterRequeue.parked).toBe(before.parked)
  })
})

describe('dead-letter RLS', () => {
  it('scopes reads to the owning tenant and blocks cross-tenant writes', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgA = await freshOrg()
    const orgB = await freshOrg()
    const eventId = await parkFreshEvent(orgA)

    const ownerView = await withTenantTransaction(db, orgA, (trx) =>
      trx
        .selectFrom('operations.dead_letter_events')
        .select('id')
        .where('id', '=', eventId)
        .execute()
    )
    expect(ownerView.map((row) => row.id)).toEqual([eventId])

    const foreignView = await withTenantTransaction(db, orgB, (trx) =>
      trx
        .selectFrom('operations.dead_letter_events')
        .select('id')
        .where('id', '=', eventId)
        .execute()
    )
    expect(foreignView).toEqual([])

    await expect(
      withTenantTransaction(db, orgB, (trx) =>
        trx
          .insertInto('operations.dead_letter_events')
          .values({
            id: randomUUID(),
            organization_id: orgA,
            aggregate_type: 'organization',
            aggregate_id: orgA,
            aggregate_version: 1,
            event_type: 'organization.updated',
            event_schema_version: 1,
            payload: JSON.stringify({}),
            occurred_at: sql`now()`,
            attempt_count: 1
          })
          .execute()
      )
    ).rejects.toThrow(/row-level security|permission denied/i)
  })
})
