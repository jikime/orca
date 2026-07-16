import { createDatabase, createDatabasePool, pingDatabase } from '@pie/persistence'
import pino from 'pino'
import { loadWorkerConfig } from './config'
import { createOutboxClaimLoop, type OutboxBatchSummary } from './outbox-claim-loop'
import { startWorker } from './worker-runtime'

async function main(): Promise<void> {
  const config = loadWorkerConfig()
  const logger = pino({ base: { service: config.serviceName, workerId: config.workerId } })
  const pool = createDatabasePool({ connectionString: config.databaseUrl })
  const db = createDatabase(pool)
  const runtime = await startWorker({
    ping: () => pingDatabase(pool),
    heartbeatIntervalMs: config.heartbeatIntervalMs
  })

  // Running totals emitted as a periodic structured metrics line.
  const totals: OutboxBatchSummary = {
    claimed: 0,
    published: 0,
    alreadyPublished: 0,
    requeued: 0,
    parked: 0
  }
  const claimLoop = createOutboxClaimLoop({
    db,
    workerId: config.workerId,
    batchSize: config.batchSize,
    leaseMs: config.leaseMs,
    pollIntervalMs: config.pollIntervalMs,
    maxAttempts: config.maxAttempts,
    baseBackoffMs: config.baseBackoffMs,
    maxBackoffMs: config.maxBackoffMs,
    logger,
    onBatchProcessed: (summary) => {
      totals.claimed += summary.claimed
      totals.published += summary.published
      totals.alreadyPublished += summary.alreadyPublished
      totals.requeued += summary.requeued
      totals.parked += summary.parked
    }
  })
  claimLoop.start()

  const metricsTimer = setInterval(() => {
    logger.info({ metric: 'worker.outbox_totals', ...totals }, 'worker metrics')
  }, config.metricsIntervalMs)
  if (typeof metricsTimer === 'object' && 'unref' in metricsTimer) {
    metricsTimer.unref()
  }

  const close = async (): Promise<void> => {
    clearInterval(metricsTimer)
    claimLoop.stop()
    await runtime.stop()
    // Kysely.destroy() ends the underlying pool, so we do not end it separately.
    await db.destroy()
  }
  process.on('SIGTERM', () => void close().finally(() => process.exit(0)))
  process.on('SIGINT', () => void close().finally(() => process.exit(0)))
}

main().catch((error) => {
  console.error('[control-plane-worker] failed to start', error)
  process.exit(1)
})
