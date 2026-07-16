import {
  createDatabase,
  createDatabasePool,
  pingDatabase,
  seedEntitlementManifest,
  seedRoleManifest
} from '@pie/persistence'
import pino from 'pino'
import { buildApp } from './app'
import { loadApiConfig } from './config'
import { loadAuthConfig } from './auth-config'
import { createContractSchemaRegistry } from './contract-schema-registry'
import { loadDiscoveryConfig } from './discovery-config'
import { createGatewayConnectionAuthorizer } from './gateway-connection-authorizer'
import { createKeycloakTokenVerifier } from './keycloak-token-verifier'
import { loadObjectStorageFromEnv } from './object-storage-config'
import { createRealtimeGateway } from './realtime-gateway'

async function main(): Promise<void> {
  const config = loadApiConfig()
  const pool = createDatabasePool({ connectionString: config.databaseUrl })
  const db = createDatabase(pool)
  const registry = createContractSchemaRegistry()
  const discoveryConfig = loadDiscoveryConfig()
  const tokenVerifier = createKeycloakTokenVerifier(
    loadAuthConfig(process.env, discoveryConfig.issuer)
  )
  const gateway = createRealtimeGateway({
    db,
    registry,
    // A dedicated LISTEN connection, separate from the Kysely pool.
    listenConnectionString: config.databaseUrl,
    // WS connections carry a bearer token; only a verified subject with membership
    // in the requested org may subscribe.
    authorizeConnection: createGatewayConnectionAuthorizer(db, tokenVerifier),
    logger: pino({ base: { service: config.serviceName } })
  })
  const objectStorage = loadObjectStorageFromEnv()
  if (objectStorage) {
    await objectStorage.ensureBucket()
  }
  // Materialize the role/permission vocabulary so the DB is self-contained and
  // manifest drift is detectable (idempotent — no-op when already current).
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  const app = buildApp({
    ping: () => pingDatabase(pool),
    logger: true,
    db,
    registry,
    gateway,
    discoveryConfig,
    tokenVerifier,
    // Operator bearer for /internal/*; when unset those routes stay open (dev).
    ...(process.env.PIE_OPERATOR_TOKEN ? { operatorToken: process.env.PIE_OPERATOR_TOKEN } : {}),
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
