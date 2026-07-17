import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { createControlPlaneAdmissionVerifier } from './admission-verifier'
import { loadRelayConfig } from './relay-config'
import { createRelayServer } from './relay-server'

// Entrypoint: the only place real (non-injected) clock/id/logger are wired. The
// relay is an opaque encrypted-stream ferry — it holds no business state and no
// persistence. Admission is delegated to the control plane (B2); until then this
// process refuses connections rather than admitting without verification.
function main(): void {
  const config = loadRelayConfig()
  const logger = pino({ base: { service: config.serviceName } })

  const server = createRelayServer({
    admission: createControlPlaneAdmissionVerifier(),
    clock: { now: () => Date.now() },
    connectionIds: { next: () => randomUUID() },
    limits: config.limits,
    logger,
    port: config.port
  })

  logger.info({ event: 'relay.listening', host: config.host, port: config.port }, 'relay started')

  const close = (): void => {
    void server.close().finally(() => process.exit(0))
  }
  process.on('SIGTERM', close)
  process.on('SIGINT', close)
}

main()
