import {
  createResourceAssignment,
  getBaselineVariance,
  getProjectUtilization,
  getResourceAssignment,
  listEffortEntries,
  listResourceAssignments,
  logEffortEntry,
  updateResourceAssignment,
  type EffortEntryResource,
  type PieDatabase,
  type ResourceAssignmentResource
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

// R6 slice 5 routes: the ACTUAL side of R6's "계획 대비 … 인력 과투입을 조회한다" — resource
// assignments (create/list/:update under OCC), append-only effort entries (log/list), and the two
// reads that close the exit condition: utilization (person over-allocation + man-months) and the
// planned-vs-actual variance against an immutable baseline. project.resource.read gates reads;
// project.resource.manage gates mutations.

const ASSIGNMENT_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-resource-assignment.v1.schema.json'
const ASSIGNMENT_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-resource-assignment-create.v1.schema.json'
const ASSIGNMENT_UPDATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-resource-assignment-update.v1.schema.json'
const EFFORT_ENTRY_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-effort-entry.v1.schema.json'
const EFFORT_ENTRY_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-effort-entry-create.v1.schema.json'
const UTILIZATION_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-utilization.v1.schema.json'
const VARIANCE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/planning-baseline-variance.v1.schema.json'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export type PlanningResourceRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function etag(prefix: string, version: number): string {
  return `"${prefix}-${version}"`
}

function ifMatchVersion(request: FastifyRequest, prefix: string): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? new RegExp(`^"${prefix}-(\\d+)"$`).exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export function registerPlanningResourceRoutes(
  app: FastifyInstance,
  deps: PlanningResourceRoutesDeps
): void {
  registerAssignmentRoutes(app, deps)
  registerEffortEntryRoutes(app, deps)
  registerReadRoutes(app, deps)
}

function registerAssignmentRoutes(app: FastifyInstance, deps: PlanningResourceRoutesDeps): void {
  const route = '/v1/organizations/{organizationId}/projects/{projectId}/resource-assignments'

  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/resource-assignments',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'project.resource.read'
        ))
      )
        return reply
      const items = await listResourceAssignments(deps.db, organizationId, projectId)
      for (const item of items) assertResponse(deps.registry, ASSIGNMENT_SCHEMA_ID, item)
      return { items }
    }
  )

  app.post(
    '/v1/organizations/:organizationId/projects/:projectId/resource-assignments',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'project.resource.manage'
      )
      if (!authz) return reply
      if (!validates(deps.registry, ASSIGNMENT_CREATE_SCHEMA_ID, request.body))
        return problem(
          reply,
          request,
          400,
          'VALIDATION_FAILED',
          'invalid assignment create request'
        )
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        { organizationId, principalId: principal.subject, method: 'POST', route },
        request.body
      )
      if (!gate) return reply
      const respond = (assignment: ResourceAssignmentResource): ResourceAssignmentResource => {
        assertResponse(deps.registry, ASSIGNMENT_SCHEMA_ID, assignment)
        void reply
          .code(201)
          .header('etag', etag('resource-assignment', assignment.version))
          .header(
            'location',
            `/v1/organizations/${organizationId}/projects/${projectId}/resource-assignments/${assignment.id}`
          )
        return assignment
      }
      if (gate.priorResourceId) {
        const existing = await getResourceAssignment(deps.db, organizationId, gate.priorResourceId)
        if (existing) return respond(existing)
      }
      const body = request.body as {
        userId: string
        allocationPct: number | string
        startDate: string
        endDate: string
        wbsNodeId?: string
        plannedEffortHours?: number | string
        roleLabel?: string
      }
      const result = await createResourceAssignment(deps.db, {
        organizationId,
        actorUserId: authz.userId ?? organizationId,
        projectId,
        userId: body.userId,
        allocationPct: body.allocationPct,
        startDate: body.startDate,
        endDate: body.endDate,
        wbsNodeId: body.wbsNodeId ?? null,
        plannedEffortHours: body.plannedEffortHours ?? null,
        roleLabel: body.roleLabel ?? null
      })
      if (!result.ok) {
        await gate.release()
        return assignmentInvalidProblem(reply, request, result.reason)
      }
      await gate.complete(result.assignment.id)
      return respond(result.assignment)
    }
  )

  registerAssignmentActions(app, deps)
}

function registerAssignmentActions(app: FastifyInstance, deps: PlanningResourceRoutesDeps): void {
  // Custom method on an assignment, split on the last ':' (mirrors wbs/crm): only :update here.
  app.post(
    '/v1/organizations/:organizationId/projects/:projectId/resource-assignments/:assignmentTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, assignmentTarget } = request.params as {
        organizationId: string
        assignmentTarget: string
      }
      const colon = assignmentTarget.lastIndexOf(':')
      const assignmentId = colon === -1 ? assignmentTarget : assignmentTarget.slice(0, colon)
      const action = colon === -1 ? '' : assignmentTarget.slice(colon + 1)
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(assignmentId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (action !== 'update')
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown assignment action')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'project.resource.manage'
      )
      if (!authz) return reply
      if (!validates(deps.registry, ASSIGNMENT_UPDATE_SCHEMA_ID, request.body ?? {}))
        return problem(
          reply,
          request,
          400,
          'VALIDATION_FAILED',
          'invalid assignment update request'
        )
      const expectedVersion = ifMatchVersion(request, 'resource-assignment')
      if (expectedVersion === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      const body = (request.body ?? {}) as {
        allocationPct?: number | string
        startDate?: string
        endDate?: string
        wbsNodeId?: string | null
        plannedEffortHours?: number | string | null
        roleLabel?: string | null
      }
      const result = await updateResourceAssignment(deps.db, {
        organizationId,
        actorUserId: authz.userId ?? organizationId,
        assignmentId,
        expectedVersion,
        ...(body.allocationPct === undefined ? {} : { allocationPct: body.allocationPct }),
        ...(body.startDate === undefined ? {} : { startDate: body.startDate }),
        ...(body.endDate === undefined ? {} : { endDate: body.endDate }),
        ...(body.wbsNodeId === undefined ? {} : { wbsNodeId: body.wbsNodeId }),
        ...(body.plannedEffortHours === undefined
          ? {}
          : { plannedEffortHours: body.plannedEffortHours }),
        ...(body.roleLabel === undefined ? {} : { roleLabel: body.roleLabel })
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'assignment not found')
        if (result.reason === 'version_conflict')
          return problem(
            reply,
            request,
            409,
            'VERSION_CONFLICT',
            'assignment was modified concurrently'
          )
        return assignmentInvalidProblem(reply, request, result.reason)
      }
      assertResponse(deps.registry, ASSIGNMENT_SCHEMA_ID, result.assignment)
      void reply.header('etag', etag('resource-assignment', result.assignment.version))
      return result.assignment
    }
  )
}

function assignmentInvalidProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  reason: 'invalid_allocation' | 'invalid_period'
): FastifyReply {
  if (reason === 'invalid_allocation')
    return problem(reply, request, 422, 'INVALID_ALLOCATION', 'allocation_pct must be >= 0')
  return problem(reply, request, 422, 'INVALID_PERIOD', 'start_date must be <= end_date')
}

function registerEffortEntryRoutes(app: FastifyInstance, deps: PlanningResourceRoutesDeps): void {
  const route = '/v1/organizations/{organizationId}/projects/{projectId}/effort-entries'

  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/effort-entries',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'project.resource.read'
        ))
      )
        return reply
      const query = request.query as { wbsNodeId?: string; userId?: string }
      const filter: { wbsNodeId?: string; userId?: string } = {}
      if (query.wbsNodeId !== undefined) {
        if (!UUID_PATTERN.test(query.wbsNodeId))
          return problem(reply, request, 400, 'BAD_REQUEST', 'invalid wbsNodeId')
        filter.wbsNodeId = query.wbsNodeId
      }
      if (query.userId !== undefined) {
        if (!UUID_PATTERN.test(query.userId))
          return problem(reply, request, 400, 'BAD_REQUEST', 'invalid userId')
        filter.userId = query.userId
      }
      const items = await listEffortEntries(deps.db, organizationId, projectId, filter)
      for (const item of items) assertResponse(deps.registry, EFFORT_ENTRY_SCHEMA_ID, item)
      return { items }
    }
  )

  app.post(
    '/v1/organizations/:organizationId/projects/:projectId/effort-entries',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'project.resource.manage'
      )
      if (!authz) return reply
      if (!validates(deps.registry, EFFORT_ENTRY_CREATE_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid effort entry request')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        { organizationId, principalId: principal.subject, method: 'POST', route },
        request.body
      )
      if (!gate) return reply
      const respond = (entry: EffortEntryResource): EffortEntryResource => {
        assertResponse(deps.registry, EFFORT_ENTRY_SCHEMA_ID, entry)
        void reply
          .code(201)
          .header(
            'location',
            `/v1/organizations/${organizationId}/projects/${projectId}/effort-entries/${entry.id}`
          )
        return entry
      }
      if (gate.priorResourceId) {
        const existing = (await listEffortEntries(deps.db, organizationId, projectId)).find(
          (e) => e.id === gate.priorResourceId
        )
        if (existing) return respond(existing)
      }
      const body = request.body as {
        userId: string
        entryDate: string
        effortHours: number | string
        wbsNodeId?: string
        workItemId?: string
        note?: string
      }
      const result = await logEffortEntry(deps.db, {
        organizationId,
        actorUserId: authz.userId ?? organizationId,
        projectId,
        userId: body.userId,
        entryDate: body.entryDate,
        effortHours: body.effortHours,
        wbsNodeId: body.wbsNodeId ?? null,
        workItemId: body.workItemId ?? null,
        note: body.note ?? null
      })
      if (!result.ok) {
        await gate.release()
        return problem(reply, request, 422, 'INVALID_EFFORT', 'effort_hours must be non-zero')
      }
      await gate.complete(result.entry.id)
      return respond(result.entry)
    }
  )
}

function registerReadRoutes(app: FastifyInstance, deps: PlanningResourceRoutesDeps): void {
  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/utilization',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const query = request.query as { from?: string; to?: string }
      if (
        !query.from ||
        !query.to ||
        !DATE_PATTERN.test(query.from) ||
        !DATE_PATTERN.test(query.to)
      )
        return problem(reply, request, 400, 'BAD_REQUEST', 'from and to (YYYY-MM-DD) are required')
      if (query.from > query.to)
        return problem(reply, request, 400, 'BAD_REQUEST', 'from must be <= to')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'project.resource.read'
        ))
      )
        return reply
      const result = await getProjectUtilization(
        deps.db,
        organizationId,
        projectId,
        query.from,
        query.to
      )
      assertResponse(deps.registry, UTILIZATION_SCHEMA_ID, result)
      return result
    }
  )

  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/schedule-baselines/:baselineId/variance',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, baselineId } = request.params as {
        organizationId: string
        baselineId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(baselineId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'project.resource.read'
        ))
      )
        return reply
      const result = await getBaselineVariance(deps.db, organizationId, baselineId)
      if (!result) return problem(reply, request, 404, 'NOT_FOUND', 'baseline not found')
      assertResponse(deps.registry, VARIANCE_SCHEMA_ID, result)
      return result
    }
  )
}
