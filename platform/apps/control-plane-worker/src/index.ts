import { createDatabase, createDatabasePool, pingDatabase } from '@pie/persistence'
import { loadWorkerConfig } from './config'
import { createOutboxClaimLoop } from './outbox-claim-loop'
import { startWorker } from './worker-runtime'

async function main(): Promise<void> {
  const config = loadWorkerConfig()
  const pool = createDatabasePool({ connectionString: config.databaseUrl })
  const db = createDatabase(pool)
  const runtime = await startWorker({
    ping: () => pingDatabase(pool),
    heartbeatIntervalMs: config.heartbeatIntervalMs
  })

  const claimLoop = createOutboxClaimLoop({
    db,
    workerId: config.workerId,
    batchSize: config.batchSize,
    leaseMs: config.leaseMs,
    pollIntervalMs: config.pollIntervalMs,
    maxAttempts: config.maxAttempts,
    baseBackoffMs: config.baseBackoffMs,
    maxBackoffMs: config.maxBackoffMs,
    log: (message) => console.log(message)
  })
  claimLoop.start()

  const close = async (): Promise<void> => {
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
