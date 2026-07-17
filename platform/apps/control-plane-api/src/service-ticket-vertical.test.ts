import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  computeTicketDueAt,
  computeTicketSlaStatus,
  createDatabase,
  createDatabasePool,
  getTicketSlaStatus,
  listTickets,
  runMigrations,
  seedEntitlementManifest,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  slaPhase,
  withTenantTransaction,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import {
  createContractSchemaRegistry,
  type ContractSchemaRegistry
} from './contract-schema-registry'
import { createTestTokenVerifier, TEST_ISSUER } from './authorization-test-support'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let otherOrgId = ''
let ownerId = ''

function bearerFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  })
}

async function jsonOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

function svc(org: string, suffix: string): string {
  return `/v1/organizations/${org}/service${suffix}`
}

type TicketWire = {
  id: string
  status: string
  priority: string
  version: number
  accountId: string
  assigneeUserId: string | null
  agentSessionId: string | null
  remoteSessionId: string | null
  firstRespondedAt: string | null
  firstResponseDueAt: string | null
  resolutionDueAt: string | null
  createdAt: string
}
type ReplyWire = { id: string; kind: string; visibility: string; body: string }
type SlaWire = { ticketId: string; response: string; resolution: string }

async function createAccount(name: string): Promise<string> {
  const res = await bearerFetch('owner', `/v1/organizations/${orgId}/crm/accounts`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ name, status: 'active' })
  })
  expect(res.status).toBe(201)
  return (await jsonOf<{ id: string }>(res)).id
}

async function createTicketVia(
  accountId: string,
  overrides: Record<string, unknown> = {}
): Promise<TicketWire> {
  const res = await bearerFetch('owner', svc(orgId, '/tickets'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ accountId, subject: 'Cannot log in', priority: 'high', ...overrides })
  })
  expect(res.status).toBe(201)
  return jsonOf<TicketWire>(res)
}

// Insert an execution.agent_sessions row directly (created by its OWN R5 flow in production) so the
// ticket can LINK its opaque id. Returns the opaque session id.
async function seedAgentSession(): Promise<string> {
  return withTenantTransaction(db, orgId, async (trx) => {
    const row = await trx
      .insertInto('execution.agent_sessions')
      .values({
        organization_id: orgId,
        provider: 'claude_code',
        host_id: randomUUID(),
        visibility: 'internal',
        classification: 'internal',
        created_by: ownerId
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })
}

// Insert a support.remote_sessions row directly (created by its OWN R8 flow). Returns opaque id.
async function seedRemoteSession(): Promise<string> {
  return withTenantTransaction(db, orgId, async (trx) => {
    const row = await trx
      .insertInto('support.remote_sessions')
      .values({
        organization_id: orgId,
        kind: 'support',
        host_user_id: ownerId,
        created_by: ownerId
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED service-ticket vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  app = buildApp({ ping: async () => true, db, registry, tokenVerifier: createTestTokenVerifier() })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  otherOrgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `svc-${orgId.slice(0, 8)}`,
    displayName: 'SVC'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `svc2-${otherOrgId.slice(0, 8)}`,
    displayName: 'SVC2'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  // 'member' has service.ticket.read (+ reply_public) but NOT manage — the RBAC deny test.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
  // 'customer' is an EXTERNAL customer_approver — sees only public replies (audience projection).
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'customer',
    roleIds: ['customer_approver']
  })
  // 'other' owns a DIFFERENT org — cross-tenant isolation.
  await seedMembershipFixture(db, {
    organizationId: otherOrgId,
    issuer: TEST_ISSUER,
    subject: 'other',
    roleIds: ['organization_owner']
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

// Pure SLA calc — deterministic, no DB, so it runs even when Docker is unavailable.
describe('service / SLA pure calc (R6 slice 3)', () => {
  const base = new Date('2026-07-16T00:00:00.000Z')
  it('computes due = created + priority target (high → 60m response / 480m resolution)', () => {
    const due = computeTicketDueAt(base, 'high')
    expect(due.firstResponseDueAt.toISOString()).toBe('2026-07-16T01:00:00.000Z')
    expect(due.resolutionDueAt.toISOString()).toBe('2026-07-16T08:00:00.000Z')
  })
  it('slaPhase: breached when overdue+unmet, on_track when met in time, at_risk near due', () => {
    const due = new Date('2026-07-16T01:00:00.000Z')
    expect(slaPhase(new Date('2026-07-16T02:00:00.000Z'), due, null)).toBe('breached')
    expect(
      slaPhase(new Date('2026-07-16T00:50:00.000Z'), due, new Date('2026-07-16T00:40:00.000Z'))
    ).toBe('on_track')
    expect(slaPhase(new Date('2026-07-16T00:30:00.000Z'), due, null)).toBe('at_risk')
    expect(slaPhase(new Date('2026-07-15T23:00:00.000Z'), due, null)).toBe('on_track')
  })
  it('computeTicketSlaStatus reports both dimensions', () => {
    const status = computeTicketSlaStatus(new Date('2026-07-16T09:00:00.000Z'), {
      firstResponseDueAt: new Date('2026-07-16T01:00:00.000Z'),
      resolutionDueAt: new Date('2026-07-16T08:00:00.000Z'),
      firstRespondedAt: null,
      resolvedAt: null
    })
    expect(status).toEqual({ response: 'breached', resolution: 'breached' })
  })
})

describe('service / ticket + SLA vertical (R6 slice 3)', () => {
  it('(a) ticket create computes SLA due from the priority', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Acme')
    const ticket = await createTicketVia(account, { priority: 'high' })
    expect(ticket.status).toBe('new')
    const createdMs = new Date(ticket.createdAt).getTime()
    const responseMs = new Date(ticket.firstResponseDueAt ?? '').getTime()
    const resolutionMs = new Date(ticket.resolutionDueAt ?? '').getTime()
    // high default: 60m response, 480m resolution (allow small created_at skew).
    expect(Math.abs(responseMs - createdMs - 60 * 60_000)).toBeLessThan(5_000)
    expect(Math.abs(resolutionMs - createdMs - 480 * 60_000)).toBeLessThan(5_000)
  })

  it('(b) a custom SLA policy overrides the default targets', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Policy Co')
    const policy = await jsonOf<{ id: string }>(
      await bearerFetch('owner', svc(orgId, '/sla-policies'), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({
          name: 'Gold',
          targets: { high: { responseTargetMinutes: 15, resolutionTargetMinutes: 120 } }
        })
      })
    )
    const ticket = await createTicketVia(account, { priority: 'high', slaPolicyId: policy.id })
    const createdMs = new Date(ticket.createdAt).getTime()
    const responseMs = new Date(ticket.firstResponseDueAt ?? '').getTime()
    expect(Math.abs(responseMs - createdMs - 15 * 60_000)).toBeLessThan(5_000)
  })

  it('(c) first public_reply stamps first_responded_at and moves response SLA to met', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Reply Co')
    const ticket = await createTicketVia(account)
    expect(ticket.firstRespondedAt).toBeNull()
    const reply = await bearerFetch('owner', svc(orgId, `/tickets/${ticket.id}/replies`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ kind: 'public_reply', body: 'We are investigating' })
    })
    expect(reply.status).toBe(201)
    const detail = await jsonOf<TicketWire>(
      await bearerFetch('owner', svc(orgId, `/tickets/${ticket.id}`))
    )
    expect(detail.firstRespondedAt).not.toBeNull()
    const sla = await jsonOf<SlaWire>(
      await bearerFetch('owner', svc(orgId, `/tickets/${ticket.id}/sla`))
    )
    // Responded well before due → response SLA is met (on_track).
    expect(sla.response).toBe('on_track')
  })

  it('(d) an overdue unresolved ticket reads breached (injected now)', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Breach Co')
    const ticket = await createTicketVia(account, { priority: 'normal' })
    // Query the SLA read with now = created + 100 days → both response and resolution overdue+unmet.
    const future = new Date(new Date(ticket.createdAt).getTime() + 100 * 24 * 60 * 60_000)
    const status = await getTicketSlaStatus(db, orgId, ticket.id, future)
    expect(status?.response).toBe('breached')
    expect(status?.resolution).toBe('breached')
    // The SLA-breach list filter finds it under the same injected now.
    const page = await listTickets(db, orgId, { slaBreach: true, now: future, accountId: account })
    expect(page.items.some((t) => t.id === ticket.id)).toBe(true)
  })

  it('(e) public vs internal: a customer-scoped reply list returns ONLY public replies', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Scope Co')
    const ticket = await createTicketVia(account)
    await bearerFetch('owner', svc(orgId, `/tickets/${ticket.id}/replies`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ kind: 'public_reply', body: 'PUBLIC-ANSWER' })
    })
    await bearerFetch('owner', svc(orgId, `/tickets/${ticket.id}/replies`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ kind: 'internal_memo', body: 'INTERNAL-SECRET' })
    })
    // Internal (owner) sees both kinds.
    const asOwner = await jsonOf<{ items: ReplyWire[] }>(
      await bearerFetch('owner', svc(orgId, `/tickets/${ticket.id}/replies`))
    )
    expect(asOwner.items).toHaveLength(2)
    // External customer sees ONLY the public reply — the internal memo is absent (not in list/count).
    const asCustomer = await jsonOf<{ items: ReplyWire[] }>(
      await bearerFetch('customer', svc(orgId, `/tickets/${ticket.id}/replies`))
    )
    expect(asCustomer.items).toHaveLength(1)
    expect(asCustomer.items[0]?.kind).toBe('public_reply')
    expect(asCustomer.items.some((r) => r.kind === 'internal_memo')).toBe(false)
    expect(asCustomer.items.some((r) => r.body === 'INTERNAL-SECRET')).toBe(false)
  })

  it('(f) R5/R8 reuse: link an agent_session + remote_session; detail surfaces them', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Reuse Co')
    const ticket = await createTicketVia(account)
    const agentSessionId = await seedAgentSession()
    const remoteSessionId = await seedRemoteSession()
    const linkedAgent = await bearerFetch(
      'owner',
      svc(orgId, `/tickets/${ticket.id}:link-agent-session`),
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ sessionId: agentSessionId })
      }
    )
    expect(linkedAgent.status).toBe(200)
    const linkedRemote = await bearerFetch(
      'owner',
      svc(orgId, `/tickets/${ticket.id}:link-remote-session`),
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ sessionId: remoteSessionId })
      }
    )
    expect(linkedRemote.status).toBe(200)
    const detail = await jsonOf<TicketWire>(
      await bearerFetch('owner', svc(orgId, `/tickets/${ticket.id}`))
    )
    expect(detail.agentSessionId).toBe(agentSessionId)
    expect(detail.remoteSessionId).toBe(remoteSessionId)
    // A non-existent opaque session id is refused (integrity without a cross-schema FK).
    const bogus = await bearerFetch(
      'owner',
      svc(orgId, `/tickets/${ticket.id}:link-agent-session`),
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ sessionId: randomUUID() })
      }
    )
    expect(bogus.status).toBe(422)
  })

  it('(g) status transition OCC (200 / 409 stale / 428 no If-Match) + illegal transition', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Transition Co')
    const ticket = await createTicketVia(account)
    const path = svc(orgId, `/tickets/${ticket.id}:transition`)
    const opened = await bearerFetch('owner', path, {
      method: 'POST',
      headers: {
        'idempotency-key': randomUUID(),
        'if-match': `"service-ticket-${ticket.version}"`
      },
      body: JSON.stringify({ toStatus: 'open' })
    })
    expect(opened.status).toBe(200)
    const openedTicket = await jsonOf<TicketWire>(opened)
    expect(openedTicket.status).toBe('open')
    // Stale version → 409.
    const stale = await bearerFetch('owner', path, {
      method: 'POST',
      headers: {
        'idempotency-key': randomUUID(),
        'if-match': `"service-ticket-${ticket.version}"`
      },
      body: JSON.stringify({ toStatus: 'resolved' })
    })
    expect(stale.status).toBe(409)
    // Missing If-Match → 428.
    const noIfMatch = await bearerFetch('owner', path, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ toStatus: 'resolved' })
    })
    expect(noIfMatch.status).toBe(428)
    // Illegal edge (open → new is not allowed) → 409.
    const illegal = await bearerFetch('owner', path, {
      method: 'POST',
      headers: {
        'idempotency-key': randomUUID(),
        'if-match': `"service-ticket-${openedTicket.version}"`
      },
      body: JSON.stringify({ toStatus: 'new' })
    })
    expect(illegal.status).toBe(409)
  })

  it('(h) assign sets the 담당자 and bumps version', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Assign Co')
    const ticket = await createTicketVia(account)
    const assigned = await bearerFetch('owner', svc(orgId, `/tickets/${ticket.id}:assign`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ assigneeUserId: ownerId })
    })
    expect(assigned.status).toBe(200)
    const body = await jsonOf<TicketWire>(assigned)
    expect(body.assigneeUserId).toBe(ownerId)
    expect(body.version).toBeGreaterThan(ticket.version)
  })

  it('(i) RBAC: a member without manage cannot create a ticket (403); external cannot manage', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('RBAC Co')
    const deniedMember = await bearerFetch('member', svc(orgId, '/tickets'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ accountId: account, subject: 'x' })
    })
    expect(deniedMember.status).toBe(403)
    const deniedCustomer = await bearerFetch('customer', svc(orgId, '/tickets'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ accountId: account, subject: 'x' })
    })
    expect(deniedCustomer.status).toBe(403)
  })

  it('(j) cross-tenant: another org owner cannot read this ticket (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Tenant A')
    const ticket = await createTicketVia(account)
    const denied = await bearerFetch('other', svc(orgId, `/tickets/${ticket.id}`))
    expect(denied.status).toBe(403)
  })
})
