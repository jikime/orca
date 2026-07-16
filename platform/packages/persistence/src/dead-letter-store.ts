import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { withoutTenantContext, withWorkerClaimTransaction } from './tenant-transaction'

/**
 * Relocates one parked outbox row into the dead-letter store: copies the full
 * envelope, records the park facts, and DELETES the row from the hot outbox — all
 * inside the caller's worker transaction, so a crash relocates everything or
 * nothing. The row must still be unpublished (guarded), so a racing publish wins
 * and there is nothing to dead-letter. Idempotent on the event id.
 */
export async function relocateToDeadLetter(
  trx: Transaction<Database>,
  eventId: string,
  errorCode: string,
  attemptCount: number
): Promise<void> {
  const row = await trx
    .selectFrom('operations.outbox_events')
    .selectAll()
    .where('id', '=', eventId)
    .where('published_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  if (!row) {
    return
  }
  await trx
    .insertInto('operations.dead_letter_events')
    .values({
      id: row.id,
      organization_id: row.organization_id,
      aggregate_type: row.aggregate_type,
      aggregate_id: row.aggregate_id,
      aggregate_version: row.aggregate_version,
      event_type: row.event_type,
      event_schema_version: row.event_schema_version,
      payload: JSON.stringify(row.payload),
      occurred_at: row.occurred_at,
      attempt_count: attemptCount,
      last_error_code: errorCode
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        attempt_count: attemptCount,
        last_error_code: errorCode,
        parked_at: sql`now()`,
        status: 'parked'
      })
    )
    .execute()
  await trx.deleteFrom('operations.outbox_events').where('id', '=', eventId).execute()
}

export type RequeueDeadLetterResult =
  | { outcome: 'requeued'; organizationId: string }
  | { outcome: 'not_found' }

/**
 * Operator action (no UI): moves a dead letter back onto the hot outbox with its
 * attempt count reset, marks the dead-letter row requeued (keeping it as an audit
 * trail rather than deleting), and appends an audit event. Runs cross-tenant
 * without a tenant context because dead-letter operations legitimately span orgs;
 * invoke it with an operator-privileged connection.
 */
export async function requeueDeadLetterEvent(
  db: Kysely<Database>,
  deadLetterId: string,
  requeuedBy?: string
): Promise<RequeueDeadLetterResult> {
  return withoutTenantContext(db, async (trx) => {
    const dead = await trx
      .selectFrom('operations.dead_letter_events')
      .selectAll()
      .where('id', '=', deadLetterId)
      .where('status', '=', 'parked')
      .forUpdate()
      .executeTakeFirst()
    if (!dead) {
      return { outcome: 'not_found' }
    }
    await trx
      .insertInto('operations.outbox_events')
      .values({
        id: dead.id,
        organization_id: dead.organization_id,
        aggregate_type: dead.aggregate_type,
        aggregate_id: dead.aggregate_id,
        aggregate_version: dead.aggregate_version,
        event_type: dead.event_type,
        event_schema_version: dead.event_schema_version,
        payload: JSON.stringify(dead.payload),
        occurred_at: dead.occurred_at,
        available_at: sql`now()`,
        attempt_count: 0
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          available_at: sql`now()`,
          attempt_count: 0,
          published_at: null,
          claimed_by: null,
          claim_expires_at: null
        })
      )
      .execute()
    await trx
      .updateTable('operations.dead_letter_events')
      .set({
        status: 'requeued',
        requeue_count: sql`requeue_count + 1`,
        requeued_at: sql`now()`,
        requeued_by: requeuedBy ?? null
      })
      .where('id', '=', deadLetterId)
      .execute()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: dead.organization_id,
        actor_id: requeuedBy ?? null,
        action: 'outbox.dead_letter.requeued',
        target_type: 'outbox_event',
        target_id: dead.id
      })
      .execute()
    return { outcome: 'requeued', organizationId: dead.organization_id }
  })
}

export type DeadLetterMetrics = {
  // Active (not-yet-requeued) dead letters across all tenants.
  parked: number
}

/**
 * Cross-tenant dead-letter count for ops metrics. Runs under pie_worker (its
 * grant sees every org's rows without BYPASSRLS) and returns a count only — no
 * row content leaves the query.
 */
export async function collectDeadLetterMetrics(db: Kysely<Database>): Promise<DeadLetterMetrics> {
  return withWorkerClaimTransaction(db, async (trx) => {
    const row = await trx
      .selectFrom('operations.dead_letter_events')
      .select(sql<string>`count(*) filter (where status = 'parked')`.as('parked'))
      .executeTakeFirstOrThrow()
    return { parked: Number(row.parked) }
  })
}
