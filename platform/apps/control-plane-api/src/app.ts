import fastifyWebsocket from '@fastify/websocket'
import type { ObjectStorage } from '@pie/object-storage-adapter'
import { isSessionRevoked, type PieDatabase } from '@pie/persistence'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import Fastify, { type FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { registerArtifactRoutes } from './artifact-routes'
import { registerAttachmentRoutes } from './attachment-routes'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { registerControlPlaneRoutes } from './control-plane-routes'
import { loadDiscoveryConfig, type DiscoveryConfig } from './discovery-config'
import { registerIdentityRoutes } from './identity-routes'
import { registerChannelRoutes } from './channel-routes'
import { registerNotificationRoutes } from './notification-routes'
import { registerDeliveryRoutes } from './delivery-routes'
import { registerWorkItemRoutes } from './work-item-routes'
import { registerInvitationRoutes } from './invitation-routes'
import { registerRevocationRoutes } from './revocation-routes'
import type { KeycloakTokenVerifier } from './keycloak-token-verifier'
import { extractBearerToken, registerRequestAuthentication } from './request-authentication'
import { registerDiscoveryRoute } from './discovery-route'
import { registerMetricsRoutes } from './metrics-routes'
import { registerHealthRoutes, type HealthDeps } from './health-routes'
import { registerProblemDetails } from './problem-details'
import { registerPublicPagesRoutes } from './public-pages-routes'
import type { RealtimeGateway, RealtimeSocket } from './realtime-gateway'
import { resolveTraceContext } from './request-correlation'

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string
    traceparent: string
  }
}

export type BuildAppDeps = HealthDeps & {
  logger?: boolean
  // Provided by the running service; omitted by the health/Ajv unit tests, which
  // keep the app dependency-free.
  db?: PieDatabase
  registry?: ContractSchemaRegistry
  gateway?: RealtimeGateway
  objectStorage?: ObjectStorage
  discoveryConfig?: DiscoveryConfig
  // Enables the token-authenticated identity routes (session/memberships/
  // provisioning). Omitted by the dependency-light unit tests.
  tokenVerifier?: KeycloakTokenVerifier
  // Operator bearer that gates /internal/* (metrics/ops). When set, those routes
  // require it; documented interim before full operator admin (R3+).
  operatorToken?: string
}

function adaptWebSocket(socket: WebSocket): RealtimeSocket {
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (handler) => socket.on('message', (data: Buffer) => handler(data.toString())),
    onClose: (handler) => socket.on('close', handler)
  }
}

export function buildApp(deps: BuildAppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false })

  // Consume the JSON Schema 2020-12 dialect used by contracts/schemas via an
  // Ajv 2020 validator, wired as Fastify's route-schema compiler.
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema))

  // RFC 7386 merge-patch: the contract types PATCH bodies as
  // application/merge-patch+json, which Fastify does not parse by default.
  app.addContentTypeParser(
    'application/merge-patch+json',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(body as string))
      } catch (error) {
        done(error as Error, undefined)
      }
    }
  )

  app.decorateRequest('traceId', '')
  app.decorateRequest('traceparent', '')

  // W3C Trace Context: adopt or mint a traceparent once per request, echo it, and
  // make the trace-id the correlation id used in logs and problem+json.
  app.addHook('onRequest', async (request, reply) => {
    const rawTraceparent = request.headers.traceparent
    const trace = resolveTraceContext(
      Array.isArray(rawTraceparent) ? rawTraceparent[0] : rawTraceparent
    )
    request.traceId = trace.traceId
    request.traceparent = trace.traceparent
    void reply.header('traceparent', trace.traceparent)
  })

  registerProblemDetails(app)
  registerHealthRoutes(app, deps)
  // Public utility page shell — no dependencies, no business data.
  registerPublicPagesRoutes(app)

  // Ajv 2020-12 consumption proof: this route's body schema declares the 2020-12
  // dialect and is compiled by the Ajv2020 instance above. No business logic yet.
  app.post(
    '/internal/echo',
    {
      schema: {
        body: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['message'],
          additionalProperties: false,
          properties: { message: { type: 'string', minLength: 1, maxLength: 280 } }
        }
      }
    },
    async (request) => {
      const body = request.body as { message: string }
      return { echoed: body.message }
    }
  )

  if (deps.registry) {
    // Discovery needs only the contract registry (no DB), so it is available
    // even in the dependency-light configurations.
    registerDiscoveryRoute(app, {
      registry: deps.registry,
      config: deps.discoveryConfig ?? loadDiscoveryConfig()
    })
  }

  // R3: every protected route now requires the verified token subject + membership,
  // so the token-verification decorations register once, and the tenant routes are
  // gated on the verifier being present (no verifier → the routes are not exposed).
  if (deps.tokenVerifier) {
    const db = deps.db
    registerRequestAuthentication(
      app,
      deps.tokenVerifier,
      db ? { isSessionRevoked: (sessionId) => isSessionRevoked(db, sessionId) } : {}
    )
  }

  if (deps.db && deps.registry && deps.tokenVerifier) {
    registerControlPlaneRoutes(app, { db: deps.db, registry: deps.registry })
    registerIdentityRoutes(app, {
      db: deps.db,
      registry: deps.registry,
      instanceId: (deps.discoveryConfig ?? loadDiscoveryConfig()).instanceId
    })
    registerInvitationRoutes(app, { db: deps.db })
    registerDeliveryRoutes(app, { db: deps.db, registry: deps.registry })
    registerWorkItemRoutes(app, { db: deps.db, registry: deps.registry })
    registerChannelRoutes(app, {
      db: deps.db,
      registry: deps.registry,
      ...(deps.objectStorage ? { objectStorage: deps.objectStorage } : {})
    })
    registerNotificationRoutes(app, { db: deps.db, registry: deps.registry })
    if (deps.gateway) {
      registerRevocationRoutes(app, { db: deps.db, gateway: deps.gateway })
    }
  }

  if (deps.db && deps.registry && deps.objectStorage && deps.tokenVerifier) {
    registerArtifactRoutes(app, {
      db: deps.db,
      registry: deps.registry,
      objectStorage: deps.objectStorage
    })
    registerAttachmentRoutes(app, {
      db: deps.db,
      registry: deps.registry,
      objectStorage: deps.objectStorage
    })
  }

  if (deps.db && deps.gateway) {
    registerMetricsRoutes(app, {
      db: deps.db,
      gateway: deps.gateway,
      operatorToken: deps.operatorToken
    })
  }

  if (deps.gateway) {
    const gateway = deps.gateway
    void app.register(fastifyWebsocket)
    app.register(async (scoped) => {
      scoped.get('/v1/realtime', { websocket: true }, (socket: WebSocket, request) => {
        gateway.handleConnection(
          adaptWebSocket(socket),
          extractBearerToken(request.headers.authorization)
        )
      })
    })
    app.addHook('onClose', async () => {
      gateway.broadcastClosing('server shutdown')
      await gateway.stop()
    })
  }

  return app
}
