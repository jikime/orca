import { sql, type Transaction } from 'kysely'
import type { Database } from './database-schema'

// R5 s5 batch anti-replay (doc 24 anti-forgery, EVT-004). The one-time-use per-batch nonce store.
// nonce-on-batch-not-context: the anti-replay primitive lives on the BATCH submission, not the
// signed ExecutionContext (whose canonical form is unchanged), because a signed context is a
// per-launch credential reused across many batches within its TTL. Consumption is idempotent per
// (org, installation, nonce): the SAME batchId is a legit retry, a DIFFERENT batchId is a replay.

export type BatchSubmissionNonceOutcome = 'fresh' | 'idempotent_retry' | 'replayed'

export type ConsumeBatchSubmissionNonceInput = {
  organizationId: string
  installationId: string
  submissionNonce: string
  batchId: string
  // The signed context's expiry — the nonce's TTL for pruning.
  notAfter: Date
  // Injected receive instant (determinism); expired nonces (< nowMs) are prune-eligible.
  nowMs: number
}

// A bounded prune keeps the delete cheap and cron-free: at most this many expired rows per write.
const PRUNE_LIMIT = 100

/**
 * Records the batch nonce one-time under the caller's tenant tx (RLS-scoped). Returns:
 *  - 'fresh'            — first consumption of this (installation, nonce); proceed.
 *  - 'idempotent_retry' — already consumed under the SAME batchId; a legit retry, proceed (event
 *                          idempotency dedups the events).
 *  - 'replayed'         — already consumed under a DIFFERENT batchId; a replay, the caller rejects.
 * Prunes a bounded slice of expired nonces for this org on every write (no cron).
 */
export async function consumeBatchSubmissionNonceTx(
  trx: Transaction<Database>,
  input: ConsumeBatchSubmissionNonceInput
): Promise<BatchSubmissionNonceOutcome> {
  // one-time-use: the first consumption inserts; a conflict means the nonce was already recorded.
  const inserted = await trx
    .insertInto('execution.batch_submission_nonces')
    .values({
      organization_id: input.organizationId,
      installation_id: input.installationId,
      submission_nonce: input.submissionNonce,
      batch_id: input.batchId,
      not_after: input.notAfter
    })
    .onConflict((oc) =>
      oc.columns(['organization_id', 'installation_id', 'submission_nonce']).doNothing()
    )
    .returning('batch_id')
    .executeTakeFirst()

  let outcome: BatchSubmissionNonceOutcome
  if (inserted !== undefined) {
    outcome = 'fresh'
  } else {
    const existing = await trx
      .selectFrom('execution.batch_submission_nonces')
      .select('batch_id')
      .where('organization_id', '=', input.organizationId)
      .where('installation_id', '=', input.installationId)
      .where('submission_nonce', '=', input.submissionNonce)
      .executeTakeFirst()
    // same batchId → idempotent retry; different batchId → replay of a consumed nonce.
    outcome = existing && existing.batch_id === input.batchId ? 'idempotent_retry' : 'replayed'
  }

  await pruneExpiredNoncesTx(trx, input.organizationId, new Date(input.nowMs))
  return outcome
}

// Bounded prune-on-write: delete up to PRUNE_LIMIT nonces whose TTL has passed, scoped to this org.
// The ctid subselect (Postgres physical row id) is the canonical way to cap a DELETE by row count.
// RLS already scopes visibility to the caller's org; the explicit org predicate keeps it tight.
async function pruneExpiredNoncesTx(
  trx: Transaction<Database>,
  organizationId: string,
  now: Date
): Promise<void> {
  await trx
    .deleteFrom('execution.batch_submission_nonces')
    .where('organization_id', '=', organizationId)
    .where(
      sql<boolean>`ctid in (
        select ctid
        from execution.batch_submission_nonces
        where organization_id = ${organizationId} and not_after < ${now}
        limit ${sql.lit(PRUNE_LIMIT)}
      )`
    )
    .execute()
}
