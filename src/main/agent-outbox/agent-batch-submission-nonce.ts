// R5 s5 anti-replay: the per-batch, one-time-use submission nonce. It rides the BATCH envelope
// (not the signed ExecutionContext), so the signed canonical form is unchanged — the server records
// (org, installation, nonce) once and rejects the same nonce re-presented under a DIFFERENT batchId.
//
// nonce-on-batch-not-context + retry-reuses-nonce: the nonce is keyed to batchId so an idempotent
// retry of the SAME batch reuses its nonce (the server treats same-nonce + same-batchId as a legit
// retry, never a replay); a genuinely new batch (new batchId) mints a fresh nonce. All randomness is
// injected (`mint`) so the pump stays deterministic and timer-free.

export type SubmissionNonceCache = Map<string, string>

const DEFAULT_MAX_ENTRIES = 256

/**
 * Returns the submission nonce for `batchId`, minting one on first use and reusing it on retry.
 * The cache is bounded (FIFO eviction): an evicted batchId is already terminal — it is never
 * retried — so re-minting for it would be harmless, but eviction keeps the map from growing.
 */
export function resolveSubmissionNonce(
  batchId: string,
  cache: SubmissionNonceCache,
  mint: () => string,
  maxEntries: number = DEFAULT_MAX_ENTRIES
): string {
  const existing = cache.get(batchId)
  if (existing !== undefined) {
    return existing
  }
  const nonce = mint()
  cache.set(batchId, nonce)
  if (cache.size > maxEntries) {
    // Map preserves insertion order, so the first key is the oldest batchId.
    const oldest = cache.keys().next().value
    if (oldest !== undefined) {
      cache.delete(oldest)
    }
  }
  return nonce
}
