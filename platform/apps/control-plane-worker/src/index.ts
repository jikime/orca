import { createDatabasePool, pingDatabase } from '@pie/persistence'
import { loadWorkerConfig } from './config'
import { startWorker } from './worker-runtime'

async function main(): Promise<void> {
  const config = loadWorkerConfig()
  const pool = createDatabasePool({ connectionString: config.databaseUrl })
  const runtime = await startWorker({
    ping: () => pingDatabase(pool),
    heartbeatIntervalMs: config.heartbeatIntervalMs
  })

  const close = async (): Promise<void> => {
    await runtime.stop()
    await pool.end()
  }
  process.on('SIGTERM', () => void close().finally(() => process.exit(0)))
  process.on('SIGINT', () => void close().finally(() => process.exit(0)))
}

main().catch((error) => {
  console.error('[control-plane-worker] failed to start', error)
  process.exit(1)
})
