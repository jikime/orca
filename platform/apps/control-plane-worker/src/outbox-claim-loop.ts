import {
  claimOutboxBatch,
  PoisonOutboxEventError,
  publishClaimedEvent,
  requeueFailedEvent,
  traceIdFromTraceparent,
  traceparentFromPayload,
  type PieDatabase
} from '@pie/persistence'
import { createQueuePollingLoop, NOOP_LOGGER, type StructuredLogger } from './queue-polling-loop'

export type { StructuredLogger }

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
  logger?: StructuredLogger
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
  const logger = options.logger ?? NOOP_LOGGER

  const runOnce = async (): Promise<OutboxBatchSummary> => {
    const claimed = await claimOutboxBatch(options.db, {
      workerId: options.workerId,
      batchSize: options.batchSize,
      leaseMs: options.leaseMs
    })
    const summary: OutboxBatchSummary = { ...EMPTY_SUMMARY, claimed: claimed.length }
    for (const event of claimed) {
      // Carry the request's trace id from the event envelope into the log line.
      const traceId = traceIdFromTraceparent(traceparentFromPayload(event.payload))
      try {
        const result = await publishClaimedEvent(options.db, event)
        if (result.outcome === 'published') {
          summary.published += 1
          logger.info(
            { event: 'outbox.published', outboxId: event.id, sequence: result.sequence, traceId },
            'outbox published'
          )
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
          logger.warn(
            { event: 'outbox.parked', outboxId: event.id, code, traceId },
            'outbox parked'
          )
        } else {
          summary.requeued += 1
          logger.warn(
            { event: 'outbox.requeued', outboxId: event.id, code, traceId },
            'outbox requeued'
          )
        }
      }
    }
    options.onBatchProcessed?.(summary)
    return summary
  }

  // The outbox is the first consumer of the shared SKIP LOCKED queue mechanics:
  // it supplies runOnce as the tick and reuses the generic recurring driver.
  const loop = createQueuePollingLoop({
    tick: runOnce,
    pollIntervalMs: options.pollIntervalMs,
    loopName: 'outbox',
    logger
  })

  return {
    runOnce,
    start: loop.start,
    stop: loop.stop
  }
}
