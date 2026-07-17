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
let ownerId = '' // organization_owner: full CRM incl crm.contract.approve

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

function crm(org: string, suffix: string): string {
  return `/v1/organizations/${org}/crm${suffix}`
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

type AccountWire = { id: string; name: string; status: string; version: number }
type OppWire = { id: string; stage: string; version: number }
type ContractWire = {
  id: string
  approvalStatus: string
  version: number
  approvedBy: string | null
  approvedAt: string | null
  scopeItems?: { id: string; serviceType: string }[]
}
type ChangeOrderWire = {
  id: string
  approvalStatus: string
  version: number
  scopeItems?: { id: string; serviceType: string }[]
}
type EffectiveScopeWire = {
  contract: ContractWire
  baseItems: { id: string; serviceType: string }[]
  appliedChangeOrders: { changeOrderId: string; items: { id: string }[] }[]
  effectiveItems: { id: string; serviceType: string; source: string }[]
}

async function createAccount(name: string): Promise<AccountWire> {
  const res = await bearerFetch('owner', crm(orgId, '/accounts'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ name, status: 'active' })
  })
  expect(res.status).toBe(201)
  return jsonOf<AccountWire>(res)
}

// Create → submit → approve a contract with a base scope. Returns the approved contract.
async function approvedContract(accountId: string): Promise<ContractWire> {
  const created = await bearerFetch('owner', crm(orgId, '/contracts'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      accountId,
      title: 'SI build',
      contractValue: '100000.00',
      scopeItems: [
        { serviceType: 'analysis', quantity: 1, rate: '5000.00' },
        { serviceType: 'build', quantity: 2, rate: '10000.00' }
      ]
    })
  })
  expect(created.status).toBe(201)
  let contract = await jsonOf<ContractWire>(created)
  const submitted = await bearerFetch(
    'owner',
    crm(orgId, `/contracts/${contract.id}:submit-for-approval`),
    {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"crm-contract-${contract.version}"` }
    }
  )
  expect(submitted.status).toBe(200)
  contract = await jsonOf<ContractWire>(submitted)
  expect(contract.approvalStatus).toBe('pending_approval')
  const approved = await bearerFetch('owner', crm(orgId, `/contracts/${contract.id}:approve`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID(), 'if-match': `"crm-contract-${contract.version}"` }
  })
  expect(approved.status).toBe(200)
  return jsonOf<ContractWire>(approved)
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED crm-contract vertical: Docker unavailable — ${String(error)}`)
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
    slug: `crm-${orgId.slice(0, 8)}`,
    displayName: 'CRM'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `crm2-${otherOrgId.slice(0, 8)}`,
    displayName: 'CRM2'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  // 'member' has read-only CRM (no manage/approve) — used for the RBAC deny test via its token.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
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

describe('crm / contract vertical (R6 slice 1)', () => {
  it('(a) account → site → contact customer-360 create + read', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Acme Corp')
    const site = await bearerFetch('owner', crm(orgId, `/accounts/${account.id}/sites`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'HQ', timezone: 'Asia/Seoul' })
    })
    expect(site.status).toBe(201)
    const siteBody = await jsonOf<{ id: string }>(site)
    const contact = await bearerFetch('owner', crm(orgId, `/accounts/${account.id}/contacts`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        name: 'Jane',
        email: 'jane@acme.test',
        role: 'buyer',
        siteId: siteBody.id
      })
    })
    expect(contact.status).toBe(201)
    const sites = await jsonOf<{ items: unknown[] }>(
      await bearerFetch('owner', crm(orgId, `/accounts/${account.id}/sites`))
    )
    const contacts = await jsonOf<{ items: { siteId: string | null }[] }>(
      await bearerFetch('owner', crm(orgId, `/accounts/${account.id}/contacts`))
    )
    expect(sites.items).toHaveLength(1)
    expect(contacts.items).toHaveLength(1)
    expect(contacts.items[0]?.siteId).toBe(siteBody.id)
  })

  it('(b) opportunity stage transition with OCC (200 / 409 stale / 428 no If-Match)', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Pipeline Co')
    const created = await bearerFetch(
      'owner',
      crm(orgId, `/accounts/${account.id}/opportunities`),
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ name: 'Q3 deal', amount: '50000', probability: 40 })
      }
    )
    expect(created.status).toBe(201)
    const opp = await jsonOf<OppWire>(created)
    expect(opp.stage).toBe('lead')
    const oppPath = (id: string) => crm(orgId, `/opportunities/${id}:transition`)
    const advanced = await bearerFetch('owner', oppPath(opp.id), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"crm-opportunity-${opp.version}"` },
      body: JSON.stringify({ toStage: 'qualified' })
    })
    expect(advanced.status).toBe(200)
    expect((await jsonOf<OppWire>(advanced)).stage).toBe('qualified')
    // Stale version → 409.
    const stale = await bearerFetch('owner', oppPath(opp.id), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"crm-opportunity-${opp.version}"` },
      body: JSON.stringify({ toStage: 'proposal' })
    })
    expect(stale.status).toBe(409)
    // Missing If-Match → 428.
    const noIfMatch = await bearerFetch('owner', oppPath(opp.id), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ toStage: 'proposal' })
    })
    expect(noIfMatch.status).toBe(428)
  })

  it('(c) contract carries a base scope distinct from a change order change-scope', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Scope Inc')
    const contract = await approvedContract(account.id)
    expect(contract.scopeItems).toBeUndefined() // approve response is the bare contract
    // Base scope has the 2 items from creation.
    const scope = await jsonOf<EffectiveScopeWire>(
      await bearerFetch('owner', crm(orgId, `/contracts/${contract.id}/effective-scope`))
    )
    expect(scope.baseItems).toHaveLength(2)
    // Add a change order with a DISTINCT change scope (a separate line).
    const co = await bearerFetch('owner', crm(orgId, `/contracts/${contract.id}/change-orders`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        title: 'Add migration',
        valueDelta: '20000',
        scopeItems: [{ serviceType: 'migration', quantity: 1, rate: '20000', changeKind: 'add' }]
      })
    })
    expect(co.status).toBe(201)
    const changeOrder = await jsonOf<ChangeOrderWire>(co)
    expect(changeOrder.approvalStatus).toBe('draft')
    expect(changeOrder.scopeItems).toHaveLength(1)
    // The change-scope item id is NOT one of the base-scope item ids (separate tables).
    const baseIds = new Set(scope.baseItems.map((i) => i.id))
    const changeItemId = changeOrder.scopeItems?.[0]?.id ?? ''
    expect(baseIds.has(changeItemId)).toBe(false)
    // An UNAPPROVED change order contributes nothing to the effective scope.
    const before = await jsonOf<EffectiveScopeWire>(
      await bearerFetch('owner', crm(orgId, `/contracts/${contract.id}/effective-scope`))
    )
    expect(before.appliedChangeOrders).toHaveLength(0)
    expect(before.effectiveItems.every((i) => i.source === 'base')).toBe(true)
    expect(before.effectiveItems).toHaveLength(2)
  })

  it('(d) EXIT CONDITION: no project execution before contract approval; succeeds after', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Gate Ltd')
    // A draft contract → execution refused.
    const draft = await bearerFetch('owner', crm(orgId, '/contracts'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        accountId: account.id,
        title: 'Draft SI',
        scopeItems: [{ serviceType: 'x' }]
      })
    })
    const draftContract = await jsonOf<ContractWire>(draft)
    const refused = await bearerFetch(
      'owner',
      crm(orgId, `/contracts/${draftContract.id}:create-project`),
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ projectName: 'Should not exist' })
      }
    )
    expect(refused.status).toBe(422)
    expect((await jsonOf<{ code: string }>(refused)).code).toBe('CONTRACT_NOT_APPROVED')

    // Approve the contract, then execution succeeds and links a delivery.projects row.
    const approved = await approvedContract(account.id)
    const created = await bearerFetch(
      'owner',
      crm(orgId, `/contracts/${approved.id}:create-project`),
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ projectName: 'Delivery kickoff', activate: true })
      }
    )
    expect(created.status).toBe(201)
    const link = await jsonOf<{ projectId: string; contractId: string }>(created)
    expect(link.contractId).toBe(approved.id)
    // The linked project really exists in delivery.projects (opaque link resolves).
    const project = await bearerFetch(
      'owner',
      `/v1/organizations/${orgId}/projects/${link.projectId}`
    )
    expect(project.status).toBe(200)
  })

  it('(e) a change-order delta enters the effective scope ONLY after approval', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Delta Co')
    const contract = await approvedContract(account.id)
    const co = await jsonOf<ChangeOrderWire>(
      await bearerFetch('owner', crm(orgId, `/contracts/${contract.id}/change-orders`), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({
          title: 'Extra module',
          scopeItems: [{ serviceType: 'module', quantity: 1, rate: '3000' }]
        })
      })
    )
    // Approve the change order (customer-approver gate + OCC).
    const decided = await bearerFetch('owner', crm(orgId, `/change-orders/${co.id}:approve`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"crm-change-order-${co.version}"` }
    })
    expect(decided.status).toBe(200)
    expect((await jsonOf<ChangeOrderWire>(decided)).approvalStatus).toBe('approved')
    // Now the delta is part of the effective scope, and the contract shows 'changed'.
    const after = await jsonOf<EffectiveScopeWire>(
      await bearerFetch('owner', crm(orgId, `/contracts/${contract.id}/effective-scope`))
    )
    expect(after.appliedChangeOrders).toHaveLength(1)
    expect(after.effectiveItems.some((i) => i.source === 'change_order')).toBe(true)
    expect(after.contract.approvalStatus).toBe('changed')
    // A 'changed' contract is still executable.
    const exec = await bearerFetch(
      'owner',
      crm(orgId, `/contracts/${contract.id}:create-project`),
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ projectName: 'Amended delivery' })
      }
    )
    expect(exec.status).toBe(201)
  })

  it('(f) approval transitions are audited and record the approver', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Audit Co')
    const contract = await approvedContract(account.id)
    expect(contract.approvedBy).toBe(ownerId)
    expect(contract.approvedAt).not.toBeNull()
    const actions = await auditActions(contract.id)
    expect(actions).toContain('crm.contract.created')
    expect(actions).toContain('crm.contract.submit')
    expect(actions).toContain('crm.contract.approve')
  })

  it('(g) RBAC: a member without crm.contract.approve cannot approve (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('RBAC Co')
    // Owner drafts + submits so the contract is pending_approval.
    const created = await jsonOf<ContractWire>(
      await bearerFetch('owner', crm(orgId, '/contracts'), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({
          accountId: account.id,
          title: 'Gated',
          scopeItems: [{ serviceType: 'x' }]
        })
      })
    )
    const submitted = await jsonOf<ContractWire>(
      await bearerFetch('owner', crm(orgId, `/contracts/${created.id}:submit-for-approval`), {
        method: 'POST',
        headers: {
          'idempotency-key': randomUUID(),
          'if-match': `"crm-contract-${created.version}"`
        }
      })
    )
    const denied = await bearerFetch('member', crm(orgId, `/contracts/${created.id}:approve`), {
      method: 'POST',
      headers: {
        'idempotency-key': randomUUID(),
        'if-match': `"crm-contract-${submitted.version}"`
      }
    })
    expect(denied.status).toBe(403)
  })

  it('(h) cross-tenant: another org owner cannot read this org account (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const account = await createAccount('Tenant A Only')
    const denied = await bearerFetch('other', crm(orgId, `/accounts/${account.id}`))
    expect(denied.status).toBe(403)
  })
})
