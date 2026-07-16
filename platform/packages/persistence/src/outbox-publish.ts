import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangedMessage,
  encodeCursor,
  parseResourceChangeCloudEvent,
  type ResourceChangedMessage
} from './resource-change-event'
import { encodeResourceChangedNotification, RESOURCE_CHANGED_CHANNEL } from './realtime-notify'
import { withWorkerClaimTransaction } from './tenant-transaction'

export type ClaimedOutboxEvent = {
  id: string
  organizationId: string
  payload: unknown
  attemptCount: number
}

export type ClaimOptions = {
  workerId: string
  batchSize: number
  leaseMs: number
}

export class PoisonOutboxEventError extends Error {
  constructor(eventId: string) {
    super(`outbox event ${eventId} payload is not a recognizable resource-change envelope`)
    this.name = 'PoisonOutboxEventError'
  }
}

/**
 * Batch-claims unpublished, due, unparked outbox rows with FOR UPDATE SKIP LOCKED
 * (the Worker is the sole consumer, doc 30 :322) and stamps a lease. Two workers
 * racing never claim the same row because SKIP LOCKED skips already-locked rows.
 */
export async function claimOutboxBatch(
  db: Kysely<Database>,
  options: ClaimOptions
): Promise<ClaimedOutboxEvent[]> {
  const leaseSeconds = options.leaseMs / 1000
  return withWorkerClaimTransaction(db, async (trx) => {
    const rows = await trx
      .selectFrom('operations.outbox_events')
      .select(['id', 'organization_id', 'payload', 'attempt_count'])
      .where('published_at', 'is', null)
      .where('parked_at', 'is', null)
      .where('available_at', '<=', sql<Date>`now()`)
      .where((eb) =>
        eb.or([eb('claim_expires_at', 'is', null), eb('claim_expires_at', '<', sql<Date>`now()`)])
      )
      .orderBy('available_at')
      .orderBy('id')
      .limit(options.batchSize)
      .forUpdate()
      .skipLocked()
      .execute()
    if (rows.length === 0) {
      return []
    }
    await trx
      .updateTable('operations.outbox_events')
      .set({
        claimed_by: options.workerId,
        claim_expires_at: sql`now() + make_interval(secs => ${leaseSeconds})`
      })
      .where(
        'id',
        'in',
        rows.map((row) => row.id)
      )
      .execute()
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      payload: row.payload,
      attemptCount: Number(row.attempt_count)
    }))
  })
}

export type PublishResult =
  | { outcome: 'published'; sequence: number; message: ResourceChangedMessage }
  | { outcome: 'already-published' }

/**
 * Publishes one claimed event: assigns the per-org sequence, marks published_at,
 * and NOTIFYs the gateway — ALL in one transaction, so a crash publishes either
 * everything or nothing (no double delivery). Re-checking published_at IS NULL
 * under a row lock makes a racing worker or a mid-publish restart idempotent.
 * Delivery downstream is at-least-once; clients apply idempotently by cursor.
 */
export async function publishClaimedEvent(
  db: Kysely<Database>,
  event: ClaimedOutboxEvent
): Promise<PublishResult> {
  const change = parseResourceChangeCloudEvent(event.payload)
  if (!change) {
    throw new PoisonOutboxEventError(event.id)
  }
  return withWorkerClaimTransaction(db, async (trx) => {
    const locked = await trx
      .selectFrom('operations.outbox_events')
      .select('id')
      .where('id', '=', event.id)
      .where('published_at', 'is', null)
      .forUpdate()
      .executeTakeFirst()
    if (!locked) {
      return { outcome: 'already-published' }
    }
    // Atomic per-org increment; concurrent publishers of the same org serialize
    // on this row and each RETURNS a distinct sequence (no lost updates, no gaps).
    const cursorRow = await trx
      .insertInto('operations.stream_cursors')
      .values({ organization_id: event.organizationId, last_sequence: 1 })
      .onConflict((oc) =>
        oc.column('organization_id').doUpdateSet({
          last_sequence: sql`stream_cursors.last_sequence + 1`,
          updated_at: sql`now()`
        })
      )
      .returning('last_sequence')
      .executeTakeFirstOrThrow()
    const sequence = Number(cursorRow.last_sequence)
    await trx
      .updateTable('operations.outbox_events')
      .set({ stream_sequence: sequence, published_at: sql`now()`, claim_expires_at: null })
      .where('id', '=', event.id)
      .execute()
    const message = buildResourceChangedMessage(
      event.organizationId,
      change,
      encodeCursor(sequence)
    )
    // Transactional NOTIFY: reaches the gateway only if this commit succeeds.
    await sql`select pg_notify(${RESOURCE_CHANGED_CHANNEL}, ${encodeResourceChangedNotification({ organizationId: event.organizationId, sequence })})`.execute(
      trx
    )
    return { outcome: 'published', sequence, message }
  })
}

export type RequeueOptions = {
  maxAttempts: number
  baseBackoffMs: number
  maxBackoffMs: number
}

export type RequeueOutcome = 'requeued' | 'parked'

/**
 * Records a failed publish: bumps attempt_count and either backs off (exponential)
 * for another try, or — past the retry budget — parks the row as a dead letter
 * (parked_at + last_error_code) so the claim loop stops picking it up.
 */
export async function requeueFailedEvent(
  db: Kysely<Database>,
  event: ClaimedOutboxEvent,
  errorCode: string,
  options: RequeueOptions
): Promise<RequeueOutcome> {
  const nextAttempt = event.attemptCount + 1
  return withWorkerClaimTransaction(db, async (trx) => {
    if (nextAttempt >= options.maxAttempts) {
      await trx
        .updateTable('operations.outbox_events')
        .set({
          attempt_count: nextAttempt,
          parked_at: sql`now()`,
          last_error_code: errorCode,
          claimed_by: null,
          claim_expires_at: null
        })
        .where('id', '=', event.id)
        .where('published_at', 'is', null)
        .execute()
      return 'parked'
    }
    const backoffMs = Math.min(options.baseBackoffMs * 2 ** (nextAttempt - 1), options.maxBackoffMs)
    await trx
      .updateTable('operations.outbox_events')
      .set({
        attempt_count: nextAttempt,
        available_at: sql`now() + make_interval(secs => ${backoffMs / 1000})`,
        last_error_code: errorCode,
        claimed_by: null,
        claim_expires_at: null
      })
      .where('id', '=', event.id)
      .where('published_at', 'is', null)
      .execute()
    return 'requeued'
  })
}
