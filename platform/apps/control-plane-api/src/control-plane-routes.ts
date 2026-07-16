import {
  getOperationForTenant,
  listOrganizationsForTenant,
  listResourceChanges,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'

const ORGANIZATION_SCHEMA_ID = 'https://schemas.pielab.ai/resources/organization.v1.schema.json'
const CHANGE_PAGE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/change-page.v1.schema.json'
const OPERATION_SCHEMA_ID = 'https://schemas.pielab.ai/resources/operation.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ORGANIZATION_HEADER = 'x-pie-organization-id'

export type ControlPlaneRoutesDeps = {
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

// Org identity is an authn stand-in for this slice: the caller supplies it via a
// header (list/operation) or the path (changes). R3 replaces it with the token
// subject + membership check. RLS still enforces that a chosen org sees only its
// own rows, so cross-tenant reads are blocked at the database.
function organizationFromHeader(request: FastifyRequest): string | null {
  const raw = request.headers[ORGANIZATION_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && UUID_PATTERN.test(value) ? value : null
}

function assertResponseMatchesContract(
  registry: ContractSchemaRegistry,
  schemaId: string,
  body: unknown
): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
    // A response that fails its own contract is an internal error, not the
    // client's fault — surface it as 500 rather than shipping bad data.
    throw new Error(`response violates contract ${schemaId}`)
  }
}

function parseLimit(raw: unknown): number | undefined {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : undefined
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

export function registerControlPlaneRoutes(
  app: FastifyInstance,
  deps: ControlPlaneRoutesDeps
): void {
  app.get('/v1/organizations', async (request, reply) => {
    const organizationId = organizationFromHeader(request)
    if (!organizationId) {
      return problem(
        reply,
        request,
        400,
        'BAD_REQUEST',
        `missing or invalid ${ORGANIZATION_HEADER}`
      )
    }
    const items = await listOrganizationsForTenant(deps.db, organizationId)
    for (const item of items) {
      assertResponseMatchesContract(deps.registry, ORGANIZATION_SCHEMA_ID, item)
    }
    return { items, nextCursor: null }
  })

  app.get('/v1/organizations/:organizationId/changes', async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId)) {
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    }
    const query = request.query as { after?: string; limit?: string }
    const result = await listResourceChanges(deps.db, organizationId, {
      afterCursor: query.after ?? null,
      limit: parseLimit(query.limit)
    })
    if (!result.ok) {
      return problem(reply, request, 410, 'CURSOR_EXPIRED', 'the change cursor is no longer valid')
    }
    assertResponseMatchesContract(deps.registry, CHANGE_PAGE_SCHEMA_ID, result.page)
    return result.page
  })

  app.get('/v1/operations/:operationId', async (request, reply) => {
    const organizationId = organizationFromHeader(request)
    if (!organizationId) {
      return problem(
        reply,
        request,
        400,
        'BAD_REQUEST',
        `missing or invalid ${ORGANIZATION_HEADER}`
      )
    }
    const { operationId } = request.params as { operationId: string }
    if (!UUID_PATTERN.test(operationId)) {
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid operationId')
    }
    const operation = await getOperationForTenant(deps.db, organizationId, operationId)
    if (!operation) {
      return problem(reply, request, 404, 'NOT_FOUND', 'operation not found')
    }
    assertResponseMatchesContract(deps.registry, OPERATION_SCHEMA_ID, operation)
    // Strong ETag over the operation's last-modified stamp (RFC 9110). The
    // matching If-Match arrives with the write endpoints in a later slice.
    void reply.header('etag', `"operation-${operation.updatedAt}"`)
    return operation
  })
}
