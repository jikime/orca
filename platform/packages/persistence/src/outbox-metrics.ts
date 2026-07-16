import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withWorkerClaimTransaction } from './tenant-transaction'

export type OutboxMetrics = {
  published: number
  parked: number
  pending: number
  // Age of the oldest due-but-unpublished event — the worker's claim lag.
  claimLagSeconds: number
}

/**
 * Cross-tenant outbox counts for ops metrics. Runs under pie_worker (its dedicated
 * grant/policy sees every org's rows without BYPASSRLS), so this never needs a
 * tenant context and never leaks any row content — counts only.
 */
export async function collectOutboxMetrics(db: Kysely<Database>): Promise<OutboxMetrics> {
  return withWorkerClaimTransaction(db, async (trx) => {
    const row = await trx
      .selectFrom('operations.outbox_events')
      .select([
        sql<string>`count(*) filter (where published_at is not null)`.as('published'),
        sql<string>`count(*) filter (where parked_at is not null)`.as('parked'),
        sql<string>`count(*) filter (where published_at is null and parked_at is null)`.as(
          'pending'
        ),
        sql<
          string | null
        >`extract(epoch from (now() - min(available_at) filter (where published_at is null and parked_at is null)))`.as(
          'lag'
        )
      ])
      .executeTakeFirstOrThrow()
    return {
      published: Number(row.published),
      parked: Number(row.parked),
      pending: Number(row.pending),
      claimLagSeconds: row.lag ? Math.max(0, Math.floor(Number(row.lag))) : 0
    }
  })
}
