import {
  claimOutboxBatch,
  PoisonOutboxEventError,
  publishClaimedEvent,
  requeueFailedEvent,
  type PieDatabase
} from '@pie/persistence'

export type OutboxBatchSummary = {
  claimed: number
  published: number
  alreadyPublished: number
  requeued: number
  parked: number
}

export type OutboxClaimLoopOptions = {
  db: PieDatabase
  workerId: string
  batchSize: number
  leaseMs: number
  pollIntervalMs: number
  maxAttempts: number
  baseBackoffMs: number
  maxBackoffMs: number
  log?: (message: string) => void
  onBatchProcessed?: (summary: OutboxBatchSummary) => void
}

export type OutboxClaimLoop = {
  // Deterministic single pass — used by tests and by the background poll.
  runOnce: () => Promise<OutboxBatchSummary>
  start: () => void
  stop: () => void
}

const EMPTY_SUMMARY: OutboxBatchSummary = {
  claimed: 0,
  published: 0,
  alreadyPublished: 0,
  requeued: 0,
  parked: 0
}

export function createOutboxClaimLoop(options: OutboxClaimLoopOptions): OutboxClaimLoop {
  const log = options.log ?? (() => {})
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const runOnce = async (): Promise<OutboxBatchSummary> => {
    const claimed = await claimOutboxBatch(options.db, {
      workerId: options.workerId,
      batchSize: options.batchSize,
      leaseMs: options.leaseMs
    })
    const summary: OutboxBatchSummary = { ...EMPTY_SUMMARY, claimed: claimed.length }
    for (const event of claimed) {
      try {
        const result = await publishClaimedEvent(options.db, event)
        if (result.outcome === 'published') {
          summary.published += 1
        } else {
          summary.alreadyPublished += 1
        }
      } catch (error) {
        const code = error instanceof PoisonOutboxEventError ? 'POISON_PAYLOAD' : 'PUBLISH_FAILED'
        const outcome = await requeueFailedEvent(options.db, event, code, {
          maxAttempts: options.maxAttempts,
          baseBackoffMs: options.baseBackoffMs,
          maxBackoffMs: options.maxBackoffMs
        })
        if (outcome === 'parked') {
          summary.parked += 1
          log(`[control-plane-worker] parked outbox event ${event.id} (${code})`)
        } else {
          summary.requeued += 1
        }
      }
    }
    options.onBatchProcessed?.(summary)
    return summary
  }

  const scheduleNext = (): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => {
      void runOnce()
        .catch((error) => {
          // A whole-batch failure (e.g. DB blip) must not kill the loop; the next
          // tick retries, and claimed rows fall back to reclaim on lease expiry.
          log(`[control-plane-worker] claim batch failed: ${String(error)}`)
        })
        .finally(scheduleNext)
    }, options.pollIntervalMs)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
  }

  return {
    runOnce,
    start: () => {
      stopped = false
      scheduleNext()
    },
    stop: () => {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
