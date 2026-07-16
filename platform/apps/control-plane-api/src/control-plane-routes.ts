import {
  getOperationForTenant,
  listOrganizationsForSubject,
  listResourceChanges,
  withoutTenantContext,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const ORGANIZATION_SCHEMA_ID = 'https://schemas.pielab.ai/resources/organization.v1.schema.json'
const CHANGE_PAGE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/change-page.v1.schema.json'
const OPERATION_SCHEMA_ID = 'https://schemas.pielab.ai/resources/operation.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

function assertResponseMatchesContract(
  registry: ContractSchemaRegistry,
  schemaId: string,
  body: unknown
): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
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
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    // Membership-scoped: the caller only ever sees orgs they belong to (with
    // organization.read). No header, no cross-tenant listing.
    const items = await listOrganizationsForSubject(deps.db, {
      issuer: principal.issuer,
      subject: principal.subject
    })
    for (const item of items) {
      assertResponseMatchesContract(deps.registry, ORGANIZATION_SCHEMA_ID, item)
    }
    return { items, nextCursor: null }
  })

  app.get('/v1/organizations/:organizationId/changes', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId)) {
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    }
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'organization.read'
      ))
    ) {
      return reply
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
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    const { operationId } = request.params as { operationId: string }
    if (!UUID_PATTERN.test(operationId)) {
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid operationId')
    }
    // The op is not org-scoped in the path; resolve its org, then authorize the
    // caller for that org. Unknown op → 404; known but unauthorized → 403.
    const owner = await withoutTenantContext(deps.db, (trx) =>
      trx
        .selectFrom('operations.operations')
        .select('organization_id')
        .where('id', '=', operationId)
        .executeTakeFirst()
    )
    if (!owner) {
      return problem(reply, request, 404, 'NOT_FOUND', 'operation not found')
    }
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        owner.organization_id,
        'organization.read'
      ))
    ) {
      return reply
    }
    const operation = await getOperationForTenant(deps.db, owner.organization_id, operationId)
    if (!operation) {
      return problem(reply, request, 404, 'NOT_FOUND', 'operation not found')
    }
    assertResponseMatchesContract(deps.registry, OPERATION_SCHEMA_ID, operation)
    void reply.header('etag', `"operation-${operation.updatedAt}"`)
    return operation
  })
}
