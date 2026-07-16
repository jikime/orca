// The table-agnostic retry mechanics of the SKIP LOCKED job queue: attempt
// accounting, exponential backoff, and the park decision. The transactional
// outbox is the first (currently only) consumer — a future job type reuses these
// pure functions and adds its own claim/execute pair, so we do NOT grow a generic
// job framework here (doc 14 R2 "작업 큐" / job queue generalization).

export type QueueBackoffOptions = {
  maxAttempts: number
  baseBackoffMs: number
  maxBackoffMs: number
}

export type QueueRetryDecision = { outcome: 'requeue'; backoffMs: number } | { outcome: 'park' }

/**
 * Given the attempt count BEFORE this failure, decides whether the job gets one
 * more try (with exponential backoff, capped) or is dead-lettered because it has
 * exhausted the retry budget.
 */
export function decideQueueRetry(
  attemptCount: number,
  options: QueueBackoffOptions
): QueueRetryDecision {
  const nextAttempt = attemptCount + 1
  if (nextAttempt >= options.maxAttempts) {
    return { outcome: 'park' }
  }
  const backoffMs = Math.min(options.baseBackoffMs * 2 ** (nextAttempt - 1), options.maxBackoffMs)
  return { outcome: 'requeue', backoffMs }
}
