import {
  createProjectDecision,
  createProjectRisk,
  createStatusReport,
  getProjectDecision,
  getProjectGovernanceSummary,
  getProjectRisk,
  getStatusReport,
  listProjectDecisionsByProject,
  listProjectRisksByProject,
  listStatusReportsByProject,
  transitionProjectRisk,
  updateProjectRisk,
  updateStatusReport,
  type OverallStatus,
  type PieDatabase,
  type ProjectDecisionResource,
  type ProjectRiskResource,
  type RiskAction,
  type RiskCategory,
  type RiskLevel,
  type StatusReportResource
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const SCHEMA = {
  risk: 'https://schemas.pielab.ai/resources/project-risk.v1.schema.json',
  riskCreate: 'https://schemas.pielab.ai/resources/project-risk-create.v1.schema.json',
  riskUpdate: 'https://schemas.pielab.ai/resources/project-risk-update.v1.schema.json',
  riskTransition: 'https://schemas.pielab.ai/resources/project-risk-transition.v1.schema.json',
  decision: 'https://schemas.pielab.ai/resources/project-decision.v1.schema.json',
  decisionCreate: 'https://schemas.pielab.ai/resources/project-decision-create.v1.schema.json',
  statusReport: 'https://schemas.pielab.ai/resources/status-report.v1.schema.json',
  statusReportCreate: 'https://schemas.pielab.ai/resources/status-report-create.v1.schema.json',
  statusReportUpdate: 'https://schemas.pielab.ai/resources/status-report-update.v1.schema.json',
  summary: 'https://schemas.pielab.ai/resources/project-governance-summary.v1.schema.json'
} as const

const GOVERNANCE_READ = 'project.governance.read'
const GOVERNANCE_MANAGE = 'project.governance.manage'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type GovernanceRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

// Splits `<id>:<action>` (custom method), mirroring qa / change-request action routes.
function parseTarget(target: string): { id: string; action: string } {
  const colon = target.lastIndexOf(':')
  return {
    id: colon === -1 ? target : target.slice(0, colon),
    action: colon === -1 ? '' : target.slice(colon + 1)
  }
}

async function guard(
  deps: GovernanceRoutesDeps,
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  permission: string
): Promise<{ userId: string } | null> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return null
  if (!UUID_PATTERN.test(organizationId)) {
    problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    return null
  }
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    permission
  )
  if (!authz) return null
  return { userId: authz.userId ?? organizationId }
}

export function registerGovernanceRoutes(app: FastifyInstance, deps: GovernanceRoutesDeps): void {
  registerRiskRoutes(app, deps)
  registerDecisionRoutes(app, deps)
  registerStatusReportRoutes(app, deps)
  registerSummaryRoute(app, deps)
}

// === risks ===
function registerRiskRoutes(app: FastifyInstance, deps: GovernanceRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/projects/:projectId/risks', (request, reply) =>
    createRiskHandler(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/projects/:projectId/risks', async (request, reply) => {
    const { organizationId, projectId } = request.params as {
      organizationId: string
      projectId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(projectId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
    const { cursor } = request.query as { cursor?: string }
    const page = await listProjectRisksByProject(deps.db, organizationId, projectId, {
      cursor: cursor ?? null
    })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.risk, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
  app.get('/v1/organizations/:organizationId/risks/:riskId', async (request, reply) => {
    const { organizationId, riskId } = request.params as {
      organizationId: string
      riskId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(riskId)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const risk = await getProjectRisk(deps.db, organizationId, riskId)
    if (!risk) return problem(reply, request, 404, 'NOT_FOUND', 'risk not found')
    assertResponse(deps.registry, SCHEMA.risk, risk)
    void reply.header('etag', etag('project-risk', risk.version))
    return risk
  })
  app.patch('/v1/organizations/:organizationId/risks/:riskId', (request, reply) =>
    updateRiskHandler(app, deps, request, reply)
  )
  app.post('/v1/organizations/:organizationId/risks/:riskTarget', (request, reply) =>
    transitionRiskHandler(app, deps, request, reply)
  )
}

async function createRiskHandler(
  app: FastifyInstance,
  deps: GovernanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, projectId } = request.params as {
    organizationId: string
    projectId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(projectId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
  if (!validates(deps.registry, SCHEMA.riskCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid risk create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/projects/{projectId}/risks'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (risk: ProjectRiskResource): ProjectRiskResource => {
    assertResponse(deps.registry, SCHEMA.risk, risk)
    void reply
      .code(201)
      .header('etag', etag('project-risk', risk.version))
      .header('location', `/v1/organizations/${organizationId}/risks/${risk.id}`)
    return risk
  }
  if (gate.priorResourceId) {
    const existing = await getProjectRisk(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const body = request.body as {
    title: string
    description?: string
    category?: RiskCategory
    probability?: RiskLevel
    impact?: RiskLevel
    mitigation?: string
    ownerUserId?: string
  }
  const created = await createProjectRisk(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    projectId,
    title: body.title,
    description: body.description ?? null,
    category: body.category,
    probability: body.probability,
    impact: body.impact,
    mitigation: body.mitigation ?? null,
    ownerUserId: body.ownerUserId ?? null
  })
  await gate.complete(created.id)
  return respond(created)
}

async function updateRiskHandler(
  app: FastifyInstance,
  deps: GovernanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, riskId } = request.params as {
    organizationId: string
    riskId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(riskId)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.riskUpdate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid risk update')
  const expectedVersion = ifMatchVersion(request, 'project-risk')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    title?: string
    description?: string | null
    category?: RiskCategory
    probability?: RiskLevel
    impact?: RiskLevel
    mitigation?: string | null
    ownerUserId?: string | null
  }
  const result = await updateProjectRisk(deps.db, {
    organizationId,
    riskId,
    actorUserId: auth.userId,
    expectedVersion,
    ...body
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'risk not found')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'risk modified concurrently')
  }
  assertResponse(deps.registry, SCHEMA.risk, result.risk)
  void reply.header('etag', etag('project-risk', result.risk.version))
  return result.risk
}

function isRiskAction(action: string): action is RiskAction {
  return action === 'mitigate' || action === 'close' || action === 'accept' || action === 'reopen'
}

async function transitionRiskHandler(
  app: FastifyInstance,
  deps: GovernanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, riskTarget } = request.params as {
    organizationId: string
    riskTarget: string
  }
  const { id, action } = parseTarget(riskTarget)
  if (action !== 'transition')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown risk action')
  const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(id)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.riskTransition, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transition')
  const expectedVersion = ifMatchVersion(request, 'project-risk')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const move = (request.body as { action?: string }).action ?? ''
  if (!isRiskAction(move))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid risk action')
  const result = await transitionProjectRisk(deps.db, {
    organizationId,
    riskId: id,
    actorUserId: auth.userId,
    action: move,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'risk not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'risk modified concurrently')
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${move} a risk in ${result.from}`
    )
  }
  assertResponse(deps.registry, SCHEMA.risk, result.risk)
  void reply.header('etag', etag('project-risk', result.risk.version))
  return result.risk
}

// === decisions (append-oriented: create + get + list, no in-place edit) ===
function registerDecisionRoutes(app: FastifyInstance, deps: GovernanceRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/projects/:projectId/decisions', (request, reply) =>
    createDecisionHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/decisions',
    async (request, reply) => {
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
      const { cursor } = request.query as { cursor?: string }
      const page = await listProjectDecisionsByProject(deps.db, organizationId, projectId, {
        cursor: cursor ?? null
      })
      for (const item of page.items) assertResponse(deps.registry, SCHEMA.decision, item)
      return { items: page.items, nextCursor: page.nextCursor }
    }
  )
  app.get('/v1/organizations/:organizationId/decisions/:decisionId', async (request, reply) => {
    const { organizationId, decisionId } = request.params as {
      organizationId: string
      decisionId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(decisionId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const decision = await getProjectDecision(deps.db, organizationId, decisionId)
    if (!decision) return problem(reply, request, 404, 'NOT_FOUND', 'decision not found')
    assertResponse(deps.registry, SCHEMA.decision, decision)
    void reply.header('etag', etag('project-decision', decision.version))
    return decision
  })
}

async function createDecisionHandler(
  app: FastifyInstance,
  deps: GovernanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, projectId } = request.params as {
    organizationId: string
    projectId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(projectId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
  if (!validates(deps.registry, SCHEMA.decisionCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid decision create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/projects/{projectId}/decisions'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (decision: ProjectDecisionResource): ProjectDecisionResource => {
    assertResponse(deps.registry, SCHEMA.decision, decision)
    void reply
      .code(201)
      .header('etag', etag('project-decision', decision.version))
      .header('location', `/v1/organizations/${organizationId}/decisions/${decision.id}`)
    return decision
  }
  if (gate.priorResourceId) {
    const existing = await getProjectDecision(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const body = request.body as {
    title: string
    context?: string
    decision: string
    rationale?: string
    relatedRiskId?: string
    supersedesId?: string
  }
  const created = await createProjectDecision(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    projectId,
    title: body.title,
    context: body.context ?? null,
    decision: body.decision,
    rationale: body.rationale ?? null,
    relatedRiskId: body.relatedRiskId ?? null,
    supersedesId: body.supersedesId ?? null
  })
  await gate.complete(created.id)
  return respond(created)
}

// === status reports ===
function registerStatusReportRoutes(app: FastifyInstance, deps: GovernanceRoutesDeps): void {
  app.post(
    '/v1/organizations/:organizationId/projects/:projectId/status-reports',
    (request, reply) => createStatusReportHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/status-reports',
    async (request, reply) => {
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
      const { cursor } = request.query as { cursor?: string }
      const page = await listStatusReportsByProject(deps.db, organizationId, projectId, {
        cursor: cursor ?? null
      })
      for (const item of page.items) assertResponse(deps.registry, SCHEMA.statusReport, item)
      return { items: page.items, nextCursor: page.nextCursor }
    }
  )
  app.get(
    '/v1/organizations/:organizationId/status-reports/:statusReportId',
    async (request, reply) => {
      const { organizationId, statusReportId } = request.params as {
        organizationId: string
        statusReportId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(statusReportId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const statusReport = await getStatusReport(deps.db, organizationId, statusReportId)
      if (!statusReport) return problem(reply, request, 404, 'NOT_FOUND', 'status report not found')
      assertResponse(deps.registry, SCHEMA.statusReport, statusReport)
      void reply.header('etag', etag('status-report', statusReport.version))
      return statusReport
    }
  )
  app.patch('/v1/organizations/:organizationId/status-reports/:statusReportId', (request, reply) =>
    updateStatusReportHandler(app, deps, request, reply)
  )
}

async function createStatusReportHandler(
  app: FastifyInstance,
  deps: GovernanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, projectId } = request.params as {
    organizationId: string
    projectId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(projectId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
  if (!validates(deps.registry, SCHEMA.statusReportCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid status report create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/projects/{projectId}/status-reports'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (statusReport: StatusReportResource): StatusReportResource => {
    assertResponse(deps.registry, SCHEMA.statusReport, statusReport)
    void reply
      .code(201)
      .header('etag', etag('status-report', statusReport.version))
      .header('location', `/v1/organizations/${organizationId}/status-reports/${statusReport.id}`)
    return statusReport
  }
  if (gate.priorResourceId) {
    const existing = await getStatusReport(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const body = request.body as {
    periodStart: string
    periodEnd: string
    overallStatus?: OverallStatus
    summary: string
    highlights?: string
    risksSummary?: string
    nextSteps?: string
  }
  const created = await createStatusReport(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    projectId,
    periodStart: body.periodStart,
    periodEnd: body.periodEnd,
    overallStatus: body.overallStatus,
    summary: body.summary,
    highlights: body.highlights ?? null,
    risksSummary: body.risksSummary ?? null,
    nextSteps: body.nextSteps ?? null
  })
  await gate.complete(created.id)
  return respond(created)
}

async function updateStatusReportHandler(
  app: FastifyInstance,
  deps: GovernanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, statusReportId } = request.params as {
    organizationId: string
    statusReportId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(statusReportId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.statusReportUpdate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid status report update')
  const expectedVersion = ifMatchVersion(request, 'status-report')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    overallStatus?: OverallStatus
    summary?: string
    highlights?: string | null
    risksSummary?: string | null
    nextSteps?: string | null
    periodStart?: string
    periodEnd?: string
  }
  const result = await updateStatusReport(deps.db, {
    organizationId,
    statusReportId,
    actorUserId: auth.userId,
    expectedVersion,
    ...body
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'status report not found')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'status report modified concurrently')
  }
  assertResponse(deps.registry, SCHEMA.statusReport, result.statusReport)
  void reply.header('etag', etag('status-report', result.statusReport.version))
  return result.statusReport
}

// === summary read: project → open risks by severity + latest status report + recent decisions ===
function registerSummaryRoute(app: FastifyInstance, deps: GovernanceRoutesDeps): void {
  app.get(
    '/v1/organizations/:organizationId/projects/:projectId/governance',
    async (request, reply) => {
      const { organizationId, projectId } = request.params as {
        organizationId: string
        projectId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, GOVERNANCE_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(projectId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid projectId')
      const summary = await getProjectGovernanceSummary(deps.db, organizationId, projectId)
      assertResponse(deps.registry, SCHEMA.summary, summary)
      return summary
    }
  )
}
