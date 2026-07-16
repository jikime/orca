import { createDatabasePool, pingDatabase } from '@pie/persistence'
import { buildApp } from './app'
import { loadApiConfig } from './config'

async function main(): Promise<void> {
  const config = loadApiConfig()
  const pool = createDatabasePool({ connectionString: config.databaseUrl })
  const app = buildApp({ ping: () => pingDatabase(pool), logger: true })

  const close = async (): Promise<void> => {
    await app.close()
    await pool.end()
  }
  process.on('SIGTERM', () => void close().finally(() => process.exit(0)))
  process.on('SIGINT', () => void close().finally(() => process.exit(0)))

  await app.listen({ host: config.host, port: config.port })
}

main().catch((error) => {
  console.error('[control-plane-api] failed to start', error)
  process.exit(1)
})
