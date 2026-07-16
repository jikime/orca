import fastifyWebsocket from '@fastify/websocket'
import type { PieDatabase } from '@pie/persistence'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import Fastify, { type FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { registerControlPlaneRoutes } from './control-plane-routes'
import { registerHealthRoutes, type HealthDeps } from './health-routes'
import { registerProblemDetails } from './problem-details'
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

  if (deps.db && deps.registry) {
    registerControlPlaneRoutes(app, { db: deps.db, registry: deps.registry })
  }

  if (deps.gateway) {
    const gateway = deps.gateway
    void app.register(fastifyWebsocket)
    app.register(async (scoped) => {
      scoped.get('/v1/realtime', { websocket: true }, (socket: WebSocket) => {
        gateway.handleConnection(adaptWebSocket(socket))
      })
    })
    app.addHook('onClose', async () => {
      gateway.broadcastClosing('server shutdown')
      await gateway.stop()
    })
  }

  return app
}
