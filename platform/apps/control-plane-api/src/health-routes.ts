import type { FastifyInstance } from 'fastify'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'

export type HealthDeps = {
  ping: () => Promise<boolean>
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  // Liveness: the process is up. No dependency checks (doc 16 lifecycle).
  app.get('/healthz', async () => ({ status: 'ok' }))

  // Readiness: the DB answers. Failure is a 503 problem+json so a load balancer
  // can drain the instance without treating it as permanently dead.
  app.get('/readyz', async (request, reply) => {
    let ready = false
    try {
      ready = await deps.ping()
    } catch {
      ready = false
    }
    if (!ready) {
      sendProblem(
        reply,
        buildProblemDetails({
          status: 503,
          title: 'Database not ready',
          code: 'SERVICE_UNAVAILABLE',
          requestId: requestCorrelationId(request),
          instance: request.url
        })
      )
      return reply
    }
    return { status: 'ready' }
  })
}
