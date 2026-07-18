import {
  getImportRun,
  runImport,
  type ImportSource,
  type NormalizedImportItem,
  type PieDatabase,
  type RunImportResult
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

// R6 slice 6 routes: external import (Jira/Redmine/CSV, normalized upstream) with dry-run + idempotent
// re-import. project.import.manage (elevated) gates every call. The dedup is the external identity, not
// a request Idempotency-Key, so this route intentionally does NOT use beginIdempotency — re-posting the
// same items is the CORRECT re-import path and must update, never 409.

const REQUEST_SCHEMA_ID = 'https://schemas.pielab.ai/resources/import-request.v1.schema.json'
const RUN_SCHEMA_ID = 'https://schemas.pielab.ai/resources/import-run.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ImportRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function validates(registry: ContractSchemaRegistry, schemaId: string, body: unknown): boolean {
  const validate = registry.ajv.getSchema(schemaId)
  return !validate || validate(body) === true
}

function assertResponse(registry: ContractSchemaRegistry, schemaId: string, body: unknown): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${schemaId}`)
  }
}

type ImportRequestBody = {
  source: ImportSource
  dryRun: boolean
  defaultTeamId?: string
  items: NormalizedImportItem[]
}

export function registerImportRoutes(app: FastifyInstance, deps: ImportRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/imports', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'project.import.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, REQUEST_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid import request')
    const body = request.body as ImportRequestBody
    const result: RunImportResult = await runImport(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      source: body.source,
      dryRun: body.dryRun,
      defaultTeamId: body.defaultTeamId ?? null,
      items: body.items
    })
    assertResponse(deps.registry, RUN_SCHEMA_ID, result)
    // dry-run returns 200 (a preview); a real applied run returns 201 (a run resource was created).
    void reply.code(body.dryRun ? 200 : 201)
    return result
  })

  app.get('/v1/organizations/:organizationId/imports/:runId', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, runId } = request.params as { organizationId: string; runId: string }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(runId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'project.import.manage'
      ))
    )
      return reply
    const run = await getImportRun(deps.db, organizationId, runId)
    if (!run) return problem(reply, request, 404, 'NOT_FOUND', 'import run not found')
    return { run }
  })
}
