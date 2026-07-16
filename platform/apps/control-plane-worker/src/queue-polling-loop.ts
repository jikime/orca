// pino-compatible subset so loops emit structured logs and tests can capture.
export type StructuredLogger = {
  info: (fields: Record<string, unknown>, message?: string) => void
  warn: (fields: Record<string, unknown>, message?: string) => void
  error: (fields: Record<string, unknown>, message?: string) => void
}

export const NOOP_LOGGER: StructuredLogger = { info: () => {}, warn: () => {}, error: () => {} }

export type QueuePollingLoopOptions = {
  // One deterministic pass over the queue; returned to callers so they can drive
  // a single pass in tests.
  tick: () => Promise<unknown>
  pollIntervalMs: number
  // Identifies the failing loop in the batch-failure log line.
  loopName: string
  logger?: StructuredLogger
}

export type QueuePollingLoop = {
  start: () => void
  stop: () => void
}

/**
 * The table-agnostic recurring driver shared by every SKIP LOCKED queue consumer:
 * an unref'd timer that runs one pass per interval and isolates a whole-pass
 * failure (a DB blip must not kill the loop — the next tick retries and leased
 * rows fall back to reclaim on lease expiry). The transactional outbox is its
 * first consumer; a future job type supplies its own `tick`.
 */
export function createQueuePollingLoop(options: QueuePollingLoopOptions): QueuePollingLoop {
  const logger = options.logger ?? NOOP_LOGGER
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const scheduleNext = (): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => {
      void Promise.resolve()
        .then(options.tick)
        .catch((error) => {
          logger.error(
            { event: 'queue.batch_failed', loop: options.loopName, error: String(error) },
            'queue batch failed'
          )
        })
        .finally(scheduleNext)
    }, options.pollIntervalMs)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
  }

  return {
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
