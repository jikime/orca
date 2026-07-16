import { createDatabase, createDatabasePool, pingDatabase } from '@pie/persistence'
import { buildApp } from './app'
import { loadApiConfig } from './config'
import { createContractSchemaRegistry } from './contract-schema-registry'
import { loadObjectStorageFromEnv } from './object-storage-config'
import { createRealtimeGateway } from './realtime-gateway'

async function main(): Promise<void> {
  const config = loadApiConfig()
  const pool = createDatabasePool({ connectionString: config.databaseUrl })
  const db = createDatabase(pool)
  const registry = createContractSchemaRegistry()
  const gateway = createRealtimeGateway({
    db,
    registry,
    // A dedicated LISTEN connection, separate from the Kysely pool.
    listenConnectionString: config.databaseUrl
  })
  const objectStorage = loadObjectStorageFromEnv()
  if (objectStorage) {
    await objectStorage.ensureBucket()
  }
  const app = buildApp({
    ping: () => pingDatabase(pool),
    logger: true,
    db,
    registry,
    gateway,
    ...(objectStorage ? { objectStorage } : {})
  })

  const close = async (): Promise<void> => {
    await app.close()
    // Kysely.destroy() ends the underlying pool, so we do not end it separately.
    await db.destroy()
  }
  process.on('SIGTERM', () => void close().finally(() => process.exit(0)))
  process.on('SIGINT', () => void close().finally(() => process.exit(0)))

  await app.ready()
  await gateway.start()
  await app.listen({ host: config.host, port: config.port })
}

main().catch((error) => {
  console.error('[control-plane-api] failed to start', error)
  process.exit(1)
})
