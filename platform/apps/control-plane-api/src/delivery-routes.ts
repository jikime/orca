import {
  createProject,
  createTeam,
  getProject,
  getTeam,
  listProjects,
  listTeams,
  updateProject,
  type PieDatabase,
  type ProjectResource,
  type TeamResource
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission, authorizeResourcePermission } from './route-authorization'

const TEAM_SCHEMA_ID = 'https://schemas.pielab.ai/resources/team.v1.schema.json'
const PROJECT_SCHEMA_ID = 'https://schemas.pielab.ai/resources/project.v1.schema.json'
const PROJECT_CREATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/project-create.v1.schema.json'
const PROJECT_UPDATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/project-update.v1.schema.json'
const TEAM_CREATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/team-create.v1.schema.json'
// Canonical route templates scope an Idempotency-Key so different mutations never
// collide on the same key (doc 23:89-99).
const TEAMS_ROUTE = '/v1/organizations/{organizationId}/teams'
const PROJECTS_ROUTE = '/v1/organizations/{organizationId}/projects'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type DeliveryRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function projectEtag(version: number): string {
  return `"project-${version}"`
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"project-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export function registerDeliveryRoutes(app: FastifyInstance, deps: DeliveryRoutesDeps): void {
  app.get('/v1/organizations/:organizationId/teams', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'team.read'
      ))
    )
      return reply
    const items = await listTeams(deps.db, organizationId)
    for (const item of items) assertResponse(deps.registry, TEAM_SCHEMA_ID, item)
    return { items, nextCursor: null }
  })

  app.post('/v1/organizations/:organizationId/teams', async (request, reply) => {
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
      'team.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, TEAM_CREATE_SCHEMA_ID, request.body)) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid team create request')
    }
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: TEAMS_ROUTE },
      request.body
    )
    if (!gate) return reply
    const respondTeam = (team: TeamResource): TeamResource => {
      assertResponse(deps.registry, TEAM_SCHEMA_ID, team)
      void reply
        .code(201)
        .header('location', `/v1/organizations/${organizationId}/teams/${team.id}`)
      return team
    }
    if (gate.priorResourceId) {
      const existing = await getTeam(deps.db, organizationId, gate.priorResourceId)
      if (existing) return respondTeam(existing)
    }
    const body = request.body as { key: string; name: string }
    const result = await createTeam(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      key: body.key,
      name: body.name
    })
    if (!result.ok) {
      await gate.release()
      return problem(reply, request, 409, 'TEAM_KEY_TAKEN', 'team key already exists')
    }
    await gate.complete(result.team.id)
    return respondTeam(result.team)
  })

  app.get('/v1/organizations/:organizationId/teams/:teamId', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, teamId } = request.params as { organizationId: string; teamId: string }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(teamId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'team.read'
      ))
    )
      return reply
    const team = await getTeam(deps.db, organizationId, teamId)
    if (!team) return problem(reply, request, 404, 'NOT_FOUND', 'team not found')
    assertResponse(deps.registry, TEAM_SCHEMA_ID, team)
    return team
  })

  app.get('/v1/organizations/:organizationId/projects', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'project.read'
      ))
    )
      return reply
    const items = await listProjects(deps.db, organizationId)
    for (const item of items) assertResponse(deps.registry, PROJECT_SCHEMA_ID, item)
    return { items, nextCursor: null }
  })

  app.post('/v1/organizations/:organizationId/projects', async (request, reply) => {
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
      'project.create'
    )
    if (!authz) return reply
    if (!validates(deps.registry, PROJECT_CREATE_SCHEMA_ID, request.body)) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid project create request')
    }
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: PROJECTS_ROUTE },
      request.body
    )
    if (!gate) return reply
    const respondProject = (project: ProjectResource): ProjectResource => {
      assertResponse(deps.registry, PROJECT_SCHEMA_ID, project)
      void reply
        .code(201)
        .header('etag', projectEtag(project.version))
        .header('location', `/v1/organizations/${organizationId}/projects/${project.id}`)
      return project
    }
    if (gate.priorResourceId) {
      const existing = await getProject(deps.db, organizationId, gate.priorResourceId)
      if (existing) return respondProject(existing)
    }
    // Link the org's default team (the creating team). A teamId request param can
    // be added when the desktop has explicit team context.
    const teams = await listTeams(deps.db, organizationId)
    const team = teams.find((t) => t.key === 'CORE') ?? teams[0]
    if (!team) {
      await gate.release()
      return problem(reply, request, 409, 'NO_TEAM', 'org has no team to own the project')
    }
    const body = request.body as {
      name: string
      summary?: string | null
      status?: 'planned' | 'active'
    }
    const result = await createProject(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      teamId: team.id,
      name: body.name,
      summary: body.summary,
      status: body.status
    })
    if (!result.ok) {
      await gate.release()
      // Distinct from a project.create 403 permission denial.
      return problem(
        reply,
        request,
        402,
        'ENTITLEMENT_SHORTFALL',
        'organization is at its project limit'
      )
    }
    await gate.complete(result.project.id)
    return respondProject(result.project)
  })

  app.get('/v1/organizations/:organizationId/projects/:projectId', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, projectId } = request.params as {
      organizationId: string
      projectId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    // Resource-scoped: a per-project narrow/widen grant can override the role's
    // project.read (the ResourceGrant evaluator's first real production consumer).
    if (
      !(await authorizeResourcePermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        { resourceType: 'project', resourceId: projectId },
        'project.read'
      ))
    )
      return reply
    const project = await getProject(deps.db, organizationId, projectId)
    if (!project) return problem(reply, request, 404, 'NOT_FOUND', 'project not found')
    assertResponse(deps.registry, PROJECT_SCHEMA_ID, project)
    void reply.header('etag', projectEtag(project.version))
    return project
  })

  app.patch('/v1/organizations/:organizationId/projects/:projectId', async (request, reply) => {
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
        'project.update'
      ))
    )
      return reply
    const expectedVersion = ifMatchVersion(request)
    if (expectedVersion === null)
      return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
    if (!validates(deps.registry, PROJECT_UPDATE_SCHEMA_ID, request.body)) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid project update request')
    }
    const patch = request.body as { name?: string; summary?: string | null; status?: string }
    const result = await updateProject(deps.db, {
      organizationId,
      projectId,
      actorUserId: principal.subject,
      expectedVersion,
      patch
    })
    if (!result.ok && result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'project not found')
    if (!result.ok)
      return problem(reply, request, 412, 'PRECONDITION_FAILED', 'project version conflict')
    assertResponse(deps.registry, PROJECT_SCHEMA_ID, result.project)
    void reply.header('etag', projectEtag(result.project.version))
    return result.project
  })
}
