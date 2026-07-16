import { searchMessages, type PieDatabase } from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const SEARCH_RESULT_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/message-search-result.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

export type MessageSearchRoutesDeps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
}

function problem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  title: string
): FastifyReply {
  sendProblem(
    reply,
    buildProblemDetails({
      status,
      title,
      code,
      requestId: requestCorrelationId(request),
      instance: request.url
    })
  )
  return reply
}

function assertResponse(registry: ContractSchemaRegistry, schemaId: string, body: unknown): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${schemaId}`)
  }
}

export function registerMessageSearchRoutes(
  app: FastifyInstance,
  deps: MessageSearchRoutesDeps
): void {
  app.get('/v1/organizations/:organizationId/messages/search', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'message.read'
    )
    if (!authz) return reply
    const query = request.query as { q?: string; cursor?: string; limit?: string }
    // A blank/whitespace-only query has no meaning for search — 400 rather than an
    // empty page, so the caller distinguishes a bad request from a genuine no-match.
    if (typeof query.q !== 'string' || query.q.trim().length === 0)
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'q is required')
    if (query.cursor !== undefined && !UUID_PATTERN.test(query.cursor))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid cursor')
    const limit = query.limit
      ? Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
      : DEFAULT_LIMIT
    // Member-scope is enforced for the REQUESTING user, so pass the caller's Pie userId.
    const result = await searchMessages(deps.db, {
      organizationId,
      userId: authz.userId ?? organizationId,
      query: query.q,
      limit,
      ...(query.cursor ? { afterId: query.cursor } : {})
    })
    assertResponse(deps.registry, SEARCH_RESULT_SCHEMA_ID, result)
    return result
  })
}
