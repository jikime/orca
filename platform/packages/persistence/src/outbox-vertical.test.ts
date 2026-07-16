import { randomUUID } from 'node:crypto'
import { Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { updateOrganizationDisplayName, OrganizationNotFoundError } from './organization-mutation'
import { seedOrganizationFixture } from './organization-seed'
import {
  claimOutboxBatch,
  publishClaimedEvent,
  requeueFailedEvent,
  type ClaimedOutboxEvent
} from './outbox-publish'
import { getOperationForTenant } from './operation-store'
import { listResourceChanges } from './resource-changes-query'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withoutTenantContext, withTenantTransaction } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

const clock = { now: () => Date.now(), newId: () => randomUUID() }

async function freshOrg(): Promise<string> {
  const id = randomUUID()
  await seedOrganizationFixture(db, { id, slug: `org-${id.slice(0, 8)}`, displayName: 'Fresh Org' })
  return id
}

async function countRows(
  table: 'audit.audit_events' | 'operations.outbox_events' | 'operations.operations',
  orgId: string
): Promise<number> {
  return withoutTenantContext(db, async (trx) => {
    const row = await trx
      .selectFrom(table)
      .select(sql<string>`count(*)`.as('count'))
      .where('organization_id', '=', orgId)
      .executeTakeFirstOrThrow()
    return Number(row.count)
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED outbox vertical: Docker/PostgreSQL unavailable — ${String(error)}`)
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

describe('domain mutation is atomic', () => {
  it('commits org + audit + outbox + operation together', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const result = await updateOrganizationDisplayName(db, clock, {
      organizationId: orgId,
      displayName: 'Renamed'
    })
    expect(result.version).toBe(2)
    expect(await countRows('audit.audit_events', orgId)).toBe(1)
    expect(await countRows('operations.outbox_events', orgId)).toBe(1)
    expect(await countRows('operations.operations', orgId)).toBe(1)
    const org = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('identity.organizations')
        .select('display_name')
        .where('id', '=', orgId)
        .executeTakeFirst()
    )
    expect(org?.display_name).toBe('Renamed')
  })

  it('leaves no partial rows when the transaction fn throws', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    await expect(
      withTenantTransaction(db, orgId, async (trx) => {
        await trx
          .insertInto('audit.audit_events')
          .values({
            organization_id: orgId,
            action: 'x',
            target_type: 'organization',
            target_id: orgId
          })
          .execute()
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await countRows('audit.audit_events', orgId)).toBe(0)
  })

  it('rejects a mutation on a missing organization before any write', async (ctx) => {
    if (!harness) return ctx.skip()
    const missing = randomUUID()
    // The org must exist for RLS context; seed then delete to simulate absence.
    await expect(
      updateOrganizationDisplayName(db, clock, { organizationId: missing, displayName: 'X' })
    ).rejects.toBeInstanceOf(OrganizationNotFoundError)
  })
})

describe('worker claim + publish', () => {
  it('publishes each row exactly once under two concurrent workers', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const mutationCount = 6

    // The worker claims globally; publishing counts only this org's rows so
    // pending rows other tests left behind never inflate the exactly-once count.
    const drain = async (workerId: string): Promise<number> => {
      let published = 0
      for (;;) {
        const claimed = await claimOutboxBatch(db, { workerId, batchSize: 3, leaseMs: 30_000 })
        if (claimed.length === 0) break
        for (const event of claimed) {
          const result = await publishClaimedEvent(db, event)
          if (result.outcome === 'published' && event.organizationId === orgId) published += 1
        }
      }
      return published
    }

    // Clear anything pending from earlier tests, then enqueue this org's batch.
    await drain('drain-pre')
    for (let i = 0; i < mutationCount; i++) {
      await updateOrganizationDisplayName(db, clock, {
        organizationId: orgId,
        displayName: `m-${i}`
      })
    }

    const [a, b] = await Promise.all([drain('worker-a'), drain('worker-b')])
    expect(a + b).toBe(mutationCount)

    // Sequences are contiguous 1..N with no gaps or duplicates.
    const sequences = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('operations.outbox_events')
        .select('stream_sequence')
        .where('published_at', 'is not', null)
        .orderBy('stream_sequence')
        .execute()
    )
    expect(sequences.map((row) => Number(row.stream_sequence))).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('is idempotent — publishing a claimed event twice is a no-op the second time', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    await updateOrganizationDisplayName(db, clock, { organizationId: orgId, displayName: 'once' })
    const [event] = await claimOutboxBatch(db, { workerId: 'w', batchSize: 10, leaseMs: 30_000 })
    const first = await publishClaimedEvent(db, event!)
    const second = await publishClaimedEvent(db, event!)
    expect(first.outcome).toBe('published')
    expect(second.outcome).toBe('already-published')
  })

  it('parks a poison event after the retry budget', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
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
          payload: JSON.stringify({ not: 'a-cloud-event' })
        })
        .execute()
    )
    const event: ClaimedOutboxEvent = {
      id: poisonId,
      organizationId: orgId,
      payload: { not: 'a-cloud-event' },
      attemptCount: 0
    }
    await expect(publishClaimedEvent(db, event)).rejects.toThrow()
    const options = { maxAttempts: 2, baseBackoffMs: 0, maxBackoffMs: 0 }
    expect(
      await requeueFailedEvent(db, { ...event, attemptCount: 0 }, 'POISON_PAYLOAD', options)
    ).toBe('requeued')
    expect(
      await requeueFailedEvent(db, { ...event, attemptCount: 1 }, 'POISON_PAYLOAD', options)
    ).toBe('parked')
    const parked = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('operations.outbox_events')
        .select(['parked_at', 'last_error_code'])
        .where('id', '=', poisonId)
        .executeTakeFirst()
    )
    expect(parked?.parked_at).not.toBeNull()
    expect(parked?.last_error_code).toBe('POISON_PAYLOAD')
  })
})

describe('recovery feed + operations are tenant-scoped', () => {
  it('serves published changes in order and never leaks another tenant', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgA = await freshOrg()
    const orgB = await freshOrg()
    await updateOrganizationDisplayName(db, clock, { organizationId: orgA, displayName: 'A1' })
    await updateOrganizationDisplayName(db, clock, { organizationId: orgB, displayName: 'B1' })
    for (const workerId of ['w']) {
      let claimed = await claimOutboxBatch(db, { workerId, batchSize: 50, leaseMs: 30_000 })
      for (const event of claimed) await publishClaimedEvent(db, event)
    }

    const pageA = await listResourceChanges(db, orgA, {})
    expect(pageA.ok).toBe(true)
    if (pageA.ok) {
      expect(pageA.page.items.every((item) => item.organizationId === orgA)).toBe(true)
      expect(pageA.page.items.some((item) => item.organizationId === orgB)).toBe(false)
    }
  })

  it('scopes getOperation to the owning tenant', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgA = await freshOrg()
    const orgB = await freshOrg()
    const result = await updateOrganizationDisplayName(db, clock, {
      organizationId: orgA,
      displayName: 'A'
    })
    expect(await getOperationForTenant(db, orgA, result.operationId)).not.toBeNull()
    // Under org B's context, org A's operation is invisible (RLS).
    expect(await getOperationForTenant(db, orgB, result.operationId)).toBeNull()
  })

  it('rejects an unrecognized cursor with cursor_invalid (→ 410)', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const result = await listResourceChanges(db, orgId, { afterCursor: 'garbage' })
    expect(result).toEqual({ ok: false, reason: 'cursor_invalid' })
  })
})
