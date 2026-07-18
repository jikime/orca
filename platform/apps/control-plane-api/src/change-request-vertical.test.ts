import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  runMigrations,
  seedEntitlementManifest,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
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
let customerId = '' // customer_approver: project.change.approve only

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

function cr(org: string, suffix: string): string {
  return `/v1/organizations/${org}${suffix}`
}

function etag(version: number): string {
  return `"change-request-${version}"`
}

async function auditActions(targetId: string): Promise<string[]> {
  const rows = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('audit.audit_events')
      .select('action')
      .where('target_id', '=', targetId)
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
  )
  return rows.map((r) => r.action)
}

type ChangeRequestWire = {
  id: string
  projectId: string
  status: string
  version: number
  approverUserId: string | null
  decidedAt: string | null
  appliedAt: string | null
}

async function createDraft(token: string, projectId: string): Promise<ChangeRequestWire> {
  const res = await bearerFetch(token, cr(orgId, `/projects/${projectId}/change-requests`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      title: 'Extend scope',
      description: 'Add reporting module',
      scopeDelta: '+1 reporting module',
      scheduleDeltaDays: 10,
      costDelta: '15000.00'
    })
  })
  expect(res.status).toBe(201)
  return jsonOf<ChangeRequestWire>(res)
}

async function submit(token: string, id: string, version: number): Promise<ChangeRequestWire> {
  const res = await bearerFetch(token, cr(orgId, `/change-requests/${id}:submit-for-approval`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID(), 'if-match': etag(version) }
  })
  expect(res.status).toBe(200)
  return jsonOf<ChangeRequestWire>(res)
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED change-request vertical: Docker unavailable — ${String(error)}`)
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
    slug: `chg-${orgId.slice(0, 8)}`,
    displayName: 'Change'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `chg2-${otherOrgId.slice(0, 8)}`,
    displayName: 'Change2'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // 'member' has neither change.request nor change.approve — used for the approve RBAC deny.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
  // 'customer' is a customer_approver: holds change.approve (the customer-approval gate) but not request.
  customerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'customer',
      roleIds: ['customer_approver']
    })
  ).userId
  // 'other' is an owner of a DIFFERENT org — used for cross-tenant isolation.
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

describe('change-request vertical (R6 project-execution change + customer approval)', () => {
  it('(a) EXIT CONDITION: apply is refused before approval, succeeds once approved', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const draft = await createDraft('owner', projectId)
    // A draft change request cannot be executed → 422 CHANGE_NOT_APPROVED.
    const draftApply = await bearerFetch('owner', cr(orgId, `/change-requests/${draft.id}:apply`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': etag(draft.version) }
    })
    expect(draftApply.status).toBe(422)
    expect((await jsonOf<{ code: string }>(draftApply)).code).toBe('CHANGE_NOT_APPROVED')

    const submitted = await submit('owner', draft.id, draft.version)
    expect(submitted.status).toBe('submitted')
    // Still not approved → apply blocked before the customer decision.
    const submittedApply = await bearerFetch(
      'owner',
      cr(orgId, `/change-requests/${draft.id}:apply`),
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': etag(submitted.version) }
      }
    )
    expect(submittedApply.status).toBe(422)
    expect((await jsonOf<{ code: string }>(submittedApply)).code).toBe('CHANGE_NOT_APPROVED')

    // Customer approves, THEN apply executes (status → applied).
    const approved = await jsonOf<ChangeRequestWire>(
      await bearerFetch('customer', cr(orgId, `/change-requests/${draft.id}:approve`), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': etag(submitted.version) }
      })
    )
    expect(approved.status).toBe('approved')
    const applied = await bearerFetch('owner', cr(orgId, `/change-requests/${draft.id}:apply`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': etag(approved.version) }
    })
    expect(applied.status).toBe(200)
    const appliedBody = await jsonOf<ChangeRequestWire>(applied)
    expect(appliedBody.status).toBe('applied')
    expect(appliedBody.appliedAt).not.toBeNull()
    const actions = await auditActions(draft.id)
    expect(actions).toContain('change.request.apply_refused')
    expect(actions).toContain('change.request.apply')
  })

  it('(b) full lifecycle with OCC on approve (200 / 409 stale / 428 no If-Match); approver recorded', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const draft = await createDraft('owner', projectId)
    const submitted = await submit('owner', draft.id, draft.version)
    const approvePath = cr(orgId, `/change-requests/${draft.id}:approve`)
    // Missing If-Match → 428.
    const noIfMatch = await bearerFetch('customer', approvePath, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() }
    })
    expect(noIfMatch.status).toBe(428)
    // Stale version → 409.
    const stale = await bearerFetch('customer', approvePath, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': etag(draft.version) }
    })
    expect(stale.status).toBe(409)
    // Correct version → 200, approver recorded.
    const ok = await jsonOf<ChangeRequestWire>(
      await bearerFetch('customer', approvePath, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': etag(submitted.version) }
      })
    )
    expect(ok.status).toBe('approved')
    expect(ok.approverUserId).toBe(customerId)
    expect(ok.decidedAt).not.toBeNull()
  })

  it('(c) RBAC: a member without project.change.approve cannot approve (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const draft = await createDraft('owner', projectId)
    const submitted = await submit('owner', draft.id, draft.version)
    // 'member' holds neither request nor approve → the customer-approval gate denies it.
    const denied = await bearerFetch('member', cr(orgId, `/change-requests/${draft.id}:approve`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': etag(submitted.version) }
    })
    expect(denied.status).toBe(403)
    // A member cannot even open a change request (no request permission).
    const cannotCreate = await bearerFetch(
      'member',
      cr(orgId, `/projects/${projectId}/change-requests`),
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ title: 'x' })
      }
    )
    expect(cannotCreate.status).toBe(403)
  })

  it('(d) reject path: a submitted change request can be rejected and cannot then be applied', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const draft = await createDraft('owner', projectId)
    const submitted = await submit('owner', draft.id, draft.version)
    const rejected = await jsonOf<ChangeRequestWire>(
      await bearerFetch('customer', cr(orgId, `/change-requests/${draft.id}:reject`), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': etag(submitted.version) }
      })
    )
    expect(rejected.status).toBe('rejected')
    expect(rejected.approverUserId).toBe(customerId)
    const apply = await bearerFetch('owner', cr(orgId, `/change-requests/${draft.id}:apply`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': etag(rejected.version) }
    })
    expect(apply.status).toBe(422)
    expect((await jsonOf<{ code: string }>(apply)).code).toBe('CHANGE_NOT_APPROVED')
  })

  it('(e) draft edit under OCC is frozen after submit; list by project works', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const draft = await createDraft('owner', projectId)
    // Draft edit succeeds under OCC.
    const edited = await bearerFetch('owner', cr(orgId, `/change-requests/${draft.id}`), {
      method: 'PATCH',
      headers: { 'idempotency-key': randomUUID(), 'if-match': etag(draft.version) },
      body: JSON.stringify({ title: 'Extend scope (revised)' })
    })
    expect(edited.status).toBe(200)
    const editedBody = await jsonOf<ChangeRequestWire>(edited)
    const submitted = await submit('owner', draft.id, editedBody.version)
    // Once submitted, an edit is refused (frozen).
    const frozen = await bearerFetch('owner', cr(orgId, `/change-requests/${draft.id}`), {
      method: 'PATCH',
      headers: { 'idempotency-key': randomUUID(), 'if-match': etag(submitted.version) },
      body: JSON.stringify({ title: 'too late' })
    })
    expect(frozen.status).toBe(409)
    const list = await jsonOf<{ items: ChangeRequestWire[] }>(
      await bearerFetch('owner', cr(orgId, `/projects/${projectId}/change-requests`))
    )
    expect(list.items).toHaveLength(1)
    expect(list.items[0]?.id).toBe(draft.id)
  })

  it('(f) cross-tenant: another org owner cannot read this org change request (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const draft = await createDraft('owner', projectId)
    const denied = await bearerFetch('other', cr(orgId, `/change-requests/${draft.id}`))
    expect(denied.status).toBe(403)
  })
})
