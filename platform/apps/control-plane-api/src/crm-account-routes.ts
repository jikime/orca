import {
  createAccount,
  createAccountContact,
  createAccountSite,
  createOpportunity,
  getAccount,
  getOpportunity,
  listAccountContacts,
  listAccounts,
  listAccountSites,
  transitionOpportunity,
  type AccountResource,
  type OpportunityResource,
  type OpportunityStage,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const ACCOUNT_SCHEMA_ID = 'https://schemas.pielab.ai/resources/crm-account.v1.schema.json'
const ACCOUNT_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/crm-account-create.v1.schema.json'
const SITE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/crm-account-site.v1.schema.json'
const SITE_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/crm-account-site-create.v1.schema.json'
const CONTACT_SCHEMA_ID = 'https://schemas.pielab.ai/resources/crm-account-contact.v1.schema.json'
const CONTACT_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/crm-account-contact-create.v1.schema.json'
const OPPORTUNITY_SCHEMA_ID = 'https://schemas.pielab.ai/resources/crm-opportunity.v1.schema.json'
const OPPORTUNITY_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/crm-opportunity-create.v1.schema.json'
const OPPORTUNITY_TRANSITION_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/crm-opportunity-transition.v1.schema.json'

const ACCOUNTS_ROUTE = '/v1/organizations/{organizationId}/crm/accounts'
const SITES_ROUTE = '/v1/organizations/{organizationId}/crm/accounts/{accountId}/sites'
const CONTACTS_ROUTE = '/v1/organizations/{organizationId}/crm/accounts/{accountId}/contacts'
const OPPORTUNITIES_ROUTE =
  '/v1/organizations/{organizationId}/crm/accounts/{accountId}/opportunities'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CrmAccountRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function opportunityEtag(version: number): string {
  return `"crm-opportunity-${version}"`
}

function ifMatchVersion(request: FastifyRequest, prefix: string): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? new RegExp(`^"${prefix}-(\\d+)"$`).exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export function registerCrmAccountRoutes(app: FastifyInstance, deps: CrmAccountRoutesDeps): void {
  registerAccountCollection(app, deps)
  registerSiteAndContactRoutes(app, deps)
  registerOpportunityRoutes(app, deps)
}

function registerAccountCollection(app: FastifyInstance, deps: CrmAccountRoutesDeps): void {
  app.get('/v1/organizations/:organizationId/crm/accounts', async (request, reply) => {
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
        'crm.account.read'
      ))
    )
      return reply
    const { cursor } = request.query as { cursor?: string }
    const page = await listAccounts(deps.db, organizationId, { cursor: cursor ?? null })
    for (const item of page.items) assertResponse(deps.registry, ACCOUNT_SCHEMA_ID, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })

  app.post('/v1/organizations/:organizationId/crm/accounts', async (request, reply) => {
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
      'crm.account.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, ACCOUNT_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid account create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: ACCOUNTS_ROUTE },
      request.body
    )
    if (!gate) return reply
    const respond = (account: AccountResource): AccountResource => {
      assertResponse(deps.registry, ACCOUNT_SCHEMA_ID, account)
      void reply
        .code(201)
        .header('location', `/v1/organizations/${organizationId}/crm/accounts/${account.id}`)
      return account
    }
    if (gate.priorResourceId) {
      const existing = await getAccount(deps.db, organizationId, gate.priorResourceId)
      if (existing) return respond(existing)
    }
    const body = request.body as {
      name: string
      status?: 'prospect' | 'active' | 'inactive'
      ownerUserId?: string
      externalRef?: string
    }
    const account = await createAccount(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      name: body.name,
      status: body.status,
      ownerUserId: body.ownerUserId ?? null,
      externalRef: body.externalRef ?? null
    })
    await gate.complete(account.id)
    return respond(account)
  })

  app.get('/v1/organizations/:organizationId/crm/accounts/:accountId', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, accountId } = request.params as {
      organizationId: string
      accountId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(accountId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'crm.account.read'
      ))
    )
      return reply
    const account = await getAccount(deps.db, organizationId, accountId)
    if (!account) return problem(reply, request, 404, 'NOT_FOUND', 'account not found')
    assertResponse(deps.registry, ACCOUNT_SCHEMA_ID, account)
    return account
  })
}

function registerSiteAndContactRoutes(app: FastifyInstance, deps: CrmAccountRoutesDeps): void {
  const sitesPath = '/v1/organizations/:organizationId/crm/accounts/:accountId/sites'
  const contactsPath = '/v1/organizations/:organizationId/crm/accounts/:accountId/contacts'

  app.get(sitesPath, async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, accountId } = request.params as {
      organizationId: string
      accountId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(accountId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'crm.account.read'
      ))
    )
      return reply
    const items = await listAccountSites(deps.db, organizationId, accountId)
    for (const item of items) assertResponse(deps.registry, SITE_SCHEMA_ID, item)
    return { items, nextCursor: null }
  })

  app.post(sitesPath, async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, accountId } = request.params as {
      organizationId: string
      accountId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(accountId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'crm.account.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, SITE_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid site create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: SITES_ROUTE },
      request.body
    )
    if (!gate) return reply
    const body = request.body as { name: string; timezone?: string }
    const result = await createAccountSite(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      accountId,
      name: body.name,
      ...(body.timezone ? { timezone: body.timezone } : {})
    })
    if (!result.ok) {
      await gate.release()
      return problem(reply, request, 404, 'NOT_FOUND', 'account not found')
    }
    await gate.complete(result.site.id)
    assertResponse(deps.registry, SITE_SCHEMA_ID, result.site)
    void reply
      .code(201)
      .header(
        'location',
        `/v1/organizations/${organizationId}/crm/accounts/${accountId}/sites/${result.site.id}`
      )
    return result.site
  })

  app.get(contactsPath, async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, accountId } = request.params as {
      organizationId: string
      accountId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(accountId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    if (
      !(await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'crm.account.read'
      ))
    )
      return reply
    const items = await listAccountContacts(deps.db, organizationId, accountId)
    for (const item of items) assertResponse(deps.registry, CONTACT_SCHEMA_ID, item)
    return { items, nextCursor: null }
  })

  app.post(contactsPath, async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, accountId } = request.params as {
      organizationId: string
      accountId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(accountId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'crm.account.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, CONTACT_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid contact create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: CONTACTS_ROUTE },
      request.body
    )
    if (!gate) return reply
    const body = request.body as { name: string; siteId?: string; email?: string; role?: string }
    const result = await createAccountContact(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      accountId,
      siteId: body.siteId ?? null,
      name: body.name,
      email: body.email ?? null,
      role: body.role ?? null
    })
    if (!result.ok) {
      await gate.release()
      return problem(reply, request, 404, 'NOT_FOUND', 'account not found')
    }
    await gate.complete(result.contact.id)
    assertResponse(deps.registry, CONTACT_SCHEMA_ID, result.contact)
    void reply
      .code(201)
      .header(
        'location',
        `/v1/organizations/${organizationId}/crm/accounts/${accountId}/contacts/${result.contact.id}`
      )
    return result.contact
  })
}

function registerOpportunityRoutes(app: FastifyInstance, deps: CrmAccountRoutesDeps): void {
  const oppPath = '/v1/organizations/:organizationId/crm/accounts/:accountId/opportunities'

  app.post(oppPath, async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, accountId } = request.params as {
      organizationId: string
      accountId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(accountId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'crm.account.manage'
    )
    if (!authz) return reply
    if (!validates(deps.registry, OPPORTUNITY_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid opportunity create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      {
        organizationId,
        principalId: principal.subject,
        method: 'POST',
        route: OPPORTUNITIES_ROUTE
      },
      request.body
    )
    if (!gate) return reply
    const respond = (opportunity: OpportunityResource): OpportunityResource => {
      assertResponse(deps.registry, OPPORTUNITY_SCHEMA_ID, opportunity)
      void reply
        .code(201)
        .header('etag', opportunityEtag(opportunity.version))
        .header(
          'location',
          `/v1/organizations/${organizationId}/crm/opportunities/${opportunity.id}`
        )
      return opportunity
    }
    if (gate.priorResourceId) {
      const existing = await getOpportunity(deps.db, organizationId, gate.priorResourceId)
      if (existing) return respond(existing)
    }
    const body = request.body as {
      name: string
      amount?: number | string
      probability?: number
      ownerUserId?: string
      expectedCloseAt?: string
    }
    const result = await createOpportunity(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      accountId,
      name: body.name,
      amount: body.amount,
      probability: body.probability ?? null,
      ownerUserId: body.ownerUserId ?? null,
      expectedCloseAt: body.expectedCloseAt ?? null
    })
    if (!result.ok) {
      await gate.release()
      return problem(reply, request, 404, 'NOT_FOUND', 'account not found')
    }
    await gate.complete(result.opportunity.id)
    return respond(result.opportunity)
  })

  // Stage transition — a :transition custom method with OCC (If-Match). The `{opportunityId}
  // :transition` token is one param split on the last ':' (mirrors remote-session :transition).
  app.post(
    '/v1/organizations/:organizationId/crm/opportunities/:opportunityTarget',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, opportunityTarget } = request.params as {
        organizationId: string
        opportunityTarget: string
      }
      const colon = opportunityTarget.lastIndexOf(':')
      const opportunityId = colon === -1 ? opportunityTarget : opportunityTarget.slice(0, colon)
      const action = colon === -1 ? '' : opportunityTarget.slice(colon + 1)
      if (action !== 'transition')
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown opportunity action')
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(opportunityId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'crm.account.manage'
      )
      if (!authz) return reply
      const expectedVersion = ifMatchVersion(request, 'crm-opportunity')
      if (expectedVersion === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      if (!validates(deps.registry, OPPORTUNITY_TRANSITION_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transition request')
      const body = request.body as { toStage: OpportunityStage }
      const result = await transitionOpportunity(deps.db, {
        organizationId,
        opportunityId,
        actorUserId: authz.userId ?? organizationId,
        toStage: body.toStage,
        expectedVersion
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'opportunity not found')
        if (result.reason === 'version_conflict')
          return problem(
            reply,
            request,
            409,
            'VERSION_CONFLICT',
            'opportunity was modified concurrently'
          )
        return problem(
          reply,
          request,
          409,
          'ILLEGAL_TRANSITION',
          `cannot move opportunity from ${result.from} to ${body.toStage}`
        )
      }
      assertResponse(deps.registry, OPPORTUNITY_SCHEMA_ID, result.opportunity)
      void reply.header('etag', opportunityEtag(result.opportunity.version))
      return result.opportunity
    }
  )
}
