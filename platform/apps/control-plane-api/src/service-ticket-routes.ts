import {
  addReply,
  assignTicket,
  createSlaPolicy,
  createTicket,
  getTicket,
  getTicketSlaStatus,
  linkSession,
  listReplies,
  listSlaPolicies,
  listTickets,
  resolveAudience,
  transitionTicket,
  type PieDatabase,
  type ReplyKind,
  type TicketResource,
  type TicketStatus
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

// R6 slice 3: service-ticket + SLA routes. RBAC: read (list/detail/sla/replies) = service.ticket.read
// (a customer_approver-style EXTERNAL role holds it and is audience-projected to public replies only);
// create/transition/assign/link/internal-memo = service.ticket.manage; a public reply =
// service.ticket.reply_public. OCC via If-Match on :transition; outbox resource-changes in the store.

const TICKET_SCHEMA_ID = 'https://schemas.pielab.ai/resources/service-ticket.v1.schema.json'
const TICKET_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/service-ticket-create.v1.schema.json'
const REPLY_SCHEMA_ID = 'https://schemas.pielab.ai/resources/service-ticket-reply.v1.schema.json'
const REPLY_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/service-ticket-reply-create.v1.schema.json'
const TRANSITION_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/service-ticket-transition.v1.schema.json'
const ASSIGN_SCHEMA_ID = 'https://schemas.pielab.ai/resources/service-ticket-assign.v1.schema.json'
const LINK_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/service-ticket-link-session.v1.schema.json'
const SLA_SCHEMA_ID = 'https://schemas.pielab.ai/resources/service-ticket-sla.v1.schema.json'
const SLA_POLICY_SCHEMA_ID = 'https://schemas.pielab.ai/resources/service-sla-policy.v1.schema.json'
const SLA_POLICY_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/service-sla-policy-create.v1.schema.json'

const TICKETS_ROUTE = '/v1/organizations/{organizationId}/service/tickets'
const REPLIES_ROUTE = '/v1/organizations/{organizationId}/service/tickets/{ticketId}/replies'
const SLA_POLICIES_ROUTE = '/v1/organizations/{organizationId}/service/sla-policies'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ServiceTicketRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function ticketEtag(version: number): string {
  return `"service-ticket-${version}"`
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"service-ticket-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export function registerServiceTicketRoutes(
  app: FastifyInstance,
  deps: ServiceTicketRoutesDeps
): void {
  registerTicketCollection(app, deps)
  registerTicketReads(app, deps)
  registerTicketActions(app, deps)
  registerSlaPolicyRoutes(app, deps)
}

function registerTicketCollection(app: FastifyInstance, deps: ServiceTicketRoutesDeps): void {
  app.get('/v1/organizations/:organizationId/service/tickets', async (request, reply) => {
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
        'service.ticket.read'
      ))
    )
      return reply
    const query = request.query as {
      accountId?: string
      status?: string
      assigneeUserId?: string
      slaBreach?: string
      cursor?: string
    }
    const page = await listTickets(deps.db, organizationId, {
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.assigneeUserId ? { assigneeUserId: query.assigneeUserId } : {}),
      ...(query.slaBreach === 'true' ? { slaBreach: true } : {}),
      cursor: query.cursor ?? null
    })
    for (const item of page.items) assertResponse(deps.registry, TICKET_SCHEMA_ID, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })

  app.post('/v1/organizations/:organizationId/service/tickets', async (request, reply) => {
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
      'service.ticket.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, TICKET_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid ticket create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: TICKETS_ROUTE },
      request.body
    )
    if (!gate) return reply
    const respond = (ticket: TicketResource): TicketResource => {
      assertResponse(deps.registry, TICKET_SCHEMA_ID, ticket)
      void reply
        .code(201)
        .header('etag', ticketEtag(ticket.version))
        .header('location', `/v1/organizations/${organizationId}/service/tickets/${ticket.id}`)
      return ticket
    }
    if (gate.priorResourceId) {
      const existing = await getTicket(deps.db, organizationId, gate.priorResourceId)
      if (existing) return respond(existing)
    }
    const body = request.body as {
      accountId: string
      reporterContactId?: string
      subject: string
      body?: string
      priority?: string
      assigneeUserId?: string
      projectId?: string
      contractId?: string
      slaPolicyId?: string
    }
    const result = await createTicket(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      accountId: body.accountId,
      reporterContactId: body.reporterContactId ?? null,
      subject: body.subject,
      body: body.body ?? '',
      priority: body.priority,
      assigneeUserId: body.assigneeUserId ?? null,
      projectId: body.projectId ?? null,
      contractId: body.contractId ?? null,
      slaPolicyId: body.slaPolicyId ?? null
    })
    if (!result.ok) {
      await gate.release()
      return problem(reply, request, 404, 'NOT_FOUND', 'account not found')
    }
    await gate.complete(result.ticket.id)
    return respond(result.ticket)
  })
}

function registerTicketReads(app: FastifyInstance, deps: ServiceTicketRoutesDeps): void {
  app.get('/v1/organizations/:organizationId/service/tickets/:ticketId', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, ticketId } = request.params as {
      organizationId: string
      ticketId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(ticketId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'service.ticket.read'
      ))
    )
      return reply
    const ticket = await getTicket(deps.db, organizationId, ticketId)
    if (!ticket) return problem(reply, request, 404, 'NOT_FOUND', 'ticket not found')
    // The detail read surfaces the linked agent-session + remote-session ids so the R5/R8 flows are
    // reachable from the ticket.
    assertResponse(deps.registry, TICKET_SCHEMA_ID, ticket)
    void reply.header('etag', ticketEtag(ticket.version))
    return ticket
  })

  app.get(
    '/v1/organizations/:organizationId/service/tickets/:ticketId/sla',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, ticketId } = request.params as {
        organizationId: string
        ticketId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(ticketId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'service.ticket.read'
        ))
      )
        return reply
      const status = await getTicketSlaStatus(deps.db, organizationId, ticketId)
      if (!status) return problem(reply, request, 404, 'NOT_FOUND', 'ticket not found')
      assertResponse(deps.registry, SLA_SCHEMA_ID, status)
      return status
    }
  )

  // Scoped reply list: an EXTERNAL (customer) audience sees ONLY public_reply rows — internal memos
  // are excluded in the query (public-vs-internal-scope exit), never fetched. Internal sees both.
  app.get(
    '/v1/organizations/:organizationId/service/tickets/:ticketId/replies',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, ticketId } = request.params as {
        organizationId: string
        ticketId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(ticketId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (
        !(await authorizeOrgPermission(
          deps.db,
          request,
          reply,
          principal,
          organizationId,
          'service.ticket.read'
        ))
      )
        return reply
      const audience = await resolveAudience(deps.db, organizationId, principal)
      const items = await listReplies(deps.db, organizationId, ticketId, { audience })
      for (const item of items) assertResponse(deps.registry, REPLY_SCHEMA_ID, item)
      return { items, nextCursor: null }
    }
  )

  app.post(
    '/v1/organizations/:organizationId/service/tickets/:ticketId/replies',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, ticketId } = request.params as {
        organizationId: string
        ticketId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(ticketId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (!validates(deps.registry, REPLY_CREATE_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid reply create request')
      const body = request.body as { kind: ReplyKind; body: string }
      // A public reply needs reply_public; an internal memo is a manage-level (internal-only) action.
      const permission =
        body.kind === 'public_reply' ? 'service.ticket.reply_public' : 'service.ticket.manage'
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        permission
      )
      if (!authz) return reply
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        { organizationId, principalId: principal.subject, method: 'POST', route: REPLIES_ROUTE },
        request.body
      )
      if (!gate) return reply
      const result = await addReply(deps.db, {
        organizationId,
        actorUserId: authz.userId ?? organizationId,
        ticketId,
        kind: body.kind,
        body: body.body
      })
      if (!result.ok) {
        await gate.release()
        return problem(reply, request, 404, 'NOT_FOUND', 'ticket not found')
      }
      await gate.complete(result.reply.id)
      assertResponse(deps.registry, REPLY_SCHEMA_ID, result.reply)
      void reply
        .code(201)
        .header(
          'location',
          `/v1/organizations/${organizationId}/service/tickets/${ticketId}/replies/${result.reply.id}`
        )
      return result.reply
    }
  )
}

function registerTicketActions(app: FastifyInstance, deps: ServiceTicketRoutesDeps): void {
  // Custom methods on a ticket: :transition (OCC), :assign, :link-agent-session, :link-remote-session.
  // One param split on the last ':' (mirrors crm-contract / remote-session).
  app.post(
    '/v1/organizations/:organizationId/service/tickets/:ticketTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, ticketTarget } = request.params as {
        organizationId: string
        ticketTarget: string
      }
      const colon = ticketTarget.lastIndexOf(':')
      const ticketId = colon === -1 ? ticketTarget : ticketTarget.slice(0, colon)
      const action = colon === -1 ? '' : ticketTarget.slice(colon + 1)
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(ticketId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'service.ticket.manage'
      )
      if (!authz) return reply
      const actor = authz.userId ?? organizationId
      if (action === 'transition')
        return handleTransition(deps, request, reply, organizationId, ticketId, actor)
      if (action === 'assign')
        return handleAssign(deps, request, reply, organizationId, ticketId, actor)
      if (action === 'link-agent-session' || action === 'link-remote-session')
        return handleLink(deps, request, reply, organizationId, ticketId, actor, action)
      return problem(reply, request, 404, 'NOT_FOUND', 'unknown ticket action')
    }
  )
}

async function handleTransition(
  deps: ServiceTicketRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  ticketId: string,
  actorUserId: string
): Promise<unknown> {
  if (!validates(deps.registry, TRANSITION_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transition request')
  const expectedVersion = ifMatchVersion(request)
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = request.body as { toStatus: TicketStatus }
  const result = await transitionTicket(deps.db, {
    organizationId,
    ticketId,
    actorUserId,
    toStatus: body.toStatus,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'ticket not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'ticket was modified concurrently')
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot move a ticket from ${result.from}`
    )
  }
  assertResponse(deps.registry, TICKET_SCHEMA_ID, result.ticket)
  void reply.header('etag', ticketEtag(result.ticket.version))
  return result.ticket
}

async function handleAssign(
  deps: ServiceTicketRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  ticketId: string,
  actorUserId: string
): Promise<unknown> {
  if (!validates(deps.registry, ASSIGN_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid assign request')
  const body = request.body as { assigneeUserId: string | null }
  const result = await assignTicket(deps.db, {
    organizationId,
    ticketId,
    actorUserId,
    assigneeUserId: body.assigneeUserId
  })
  if (!result.ok) return problem(reply, request, 404, 'NOT_FOUND', 'ticket not found')
  assertResponse(deps.registry, TICKET_SCHEMA_ID, result.ticket)
  void reply.header('etag', ticketEtag(result.ticket.version))
  return result.ticket
}

async function handleLink(
  deps: ServiceTicketRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  ticketId: string,
  actorUserId: string,
  action: 'link-agent-session' | 'link-remote-session'
): Promise<unknown> {
  if (!validates(deps.registry, LINK_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid link request')
  const body = request.body as { sessionId: string }
  const kind = action === 'link-agent-session' ? 'agent_session' : 'remote_session'
  // R5/R8 reuse-by-link: record the opaque session id; the session itself was created by its own flow.
  const result = await linkSession(deps.db, {
    organizationId,
    actorUserId,
    ticketId,
    kind,
    sessionId: body.sessionId
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'ticket not found')
    return problem(
      reply,
      request,
      422,
      'SESSION_NOT_FOUND',
      `${kind} ${body.sessionId} does not exist`
    )
  }
  assertResponse(deps.registry, TICKET_SCHEMA_ID, result.ticket)
  void reply.header('etag', ticketEtag(result.ticket.version))
  return result.ticket
}

function registerSlaPolicyRoutes(app: FastifyInstance, deps: ServiceTicketRoutesDeps): void {
  app.get('/v1/organizations/:organizationId/service/sla-policies', async (request, reply) => {
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
        'service.ticket.read'
      ))
    )
      return reply
    const items = await listSlaPolicies(deps.db, organizationId)
    for (const item of items) assertResponse(deps.registry, SLA_POLICY_SCHEMA_ID, item)
    return { items, nextCursor: null }
  })

  app.post('/v1/organizations/:organizationId/service/sla-policies', async (request, reply) => {
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
      'service.ticket.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, SLA_POLICY_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid sla policy create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: SLA_POLICIES_ROUTE },
      request.body
    )
    if (!gate) return reply
    const body = request.body as { name: string; isDefault?: boolean; targets?: unknown }
    const result = await createSlaPolicy(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      name: body.name,
      ...(body.targets === undefined ? {} : { targets: body.targets }),
      ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault })
    })
    await gate.complete(result.policy.id)
    assertResponse(deps.registry, SLA_POLICY_SCHEMA_ID, result.policy)
    void reply
      .code(201)
      .header(
        'location',
        `/v1/organizations/${organizationId}/service/sla-policies/${result.policy.id}`
      )
    return result.policy
  })
}
