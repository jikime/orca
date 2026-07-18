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

function org(suffix: string): string {
  return `/v1/organizations/${orgId}${suffix}`
}

type Invoice = {
  id: string
  version: number
  status: string
  subtotal: string
  taxAmount: string
  total: string
  amountPaid: string
  issueDate: string | null
}

function newInvoiceBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { accountId: randomUUID(), invoiceNumber: `INV-${randomUUID().slice(0, 12)}`, ...extra }
}

async function createInvoice(body: Record<string, unknown>, token = 'owner'): Promise<Response> {
  return bearerFetch(token, org('/invoices'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

function addLine(id: string, body: Record<string, unknown>): Promise<Response> {
  return bearerFetch('owner', org(`/invoices/${id}/line-items`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

function getInvoice(id: string): Promise<Response> {
  return bearerFetch('owner', org(`/invoices/${id}`))
}

function issue(id: string, version: number): Promise<Response> {
  return bearerFetch('owner', org(`/invoices/${id}:issue`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID(), 'if-match': `"invoice-${version}"` },
    body: JSON.stringify({})
  })
}

function pay(id: string, amount: string): Promise<Response> {
  return bearerFetch('owner', org(`/invoices/${id}/payments`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ amount, method: 'bank_transfer' })
  })
}

async function issuedInvoiceWithTotal(total: string): Promise<Invoice> {
  const created = await jsonOf<Invoice>(await createInvoice(newInvoiceBody()))
  await addLine(created.id, { description: 'Service', quantity: '1', unitPrice: total })
  const current = await jsonOf<Invoice>(await getInvoice(created.id))
  const issued = await jsonOf<Invoice>(await issue(created.id, current.version))
  expect(issued.status).toBe('issued')
  return issued
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED finance vertical: Docker unavailable — ${String(error)}`)
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
    slug: `fin-${orgId.slice(0, 8)}`,
    displayName: 'Finance'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `fin2-${otherOrgId.slice(0, 8)}`,
    displayName: 'Finance2'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // 'member' has finance.invoice.read but NOT finance.invoice.manage — used for the create deny.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
  // 'other' owns a DIFFERENT org — used for cross-tenant isolation.
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

describe('finance vertical (R9 invoices + line items + payments)', () => {
  it('(a) totals: draft invoice + 2 line items → subtotal = Σ amounts, total = subtotal + tax', async (ctx) => {
    if (!harness) return ctx.skip()
    const accountId = randomUUID()
    const contractId = randomUUID()
    const created = await jsonOf<Invoice>(
      await createInvoice(
        newInvoiceBody({ accountId, contractId, currency: 'KRW', taxAmount: '35.00' })
      )
    )
    expect(created.status).toBe('draft')
    expect(created.subtotal).toBe('0.00')
    expect(created.total).toBe('35.00')

    // 2 × 100.00 = 200.00 ; 3 × 50.00 = 150.00 ; subtotal 350.00 ; total 350.00 + 35.00 = 385.00
    await addLine(created.id, { description: 'Dev hours', quantity: '2', unitPrice: '100.00' })
    await addLine(created.id, { description: 'Support', quantity: '3', unitPrice: '50.00' })

    const invoice = await jsonOf<Invoice>(await getInvoice(created.id))
    expect(invoice.subtotal).toBe('350.00')
    expect(invoice.taxAmount).toBe('35.00')
    expect(invoice.total).toBe('385.00')

    // filter by contractId includes it; a different contract excludes it.
    const mine = await jsonOf<{ items: { id: string }[] }>(
      await bearerFetch('owner', org(`/invoices?contractId=${contractId}`))
    )
    expect(mine.items.map((i) => i.id)).toContain(created.id)
    const others = await jsonOf<{ items: { id: string }[] }>(
      await bearerFetch('owner', org(`/invoices?contractId=${randomUUID()}`))
    )
    expect(others.items.map((i) => i.id)).not.toContain(created.id)
  })

  it('(b) issue gate: empty invoice → 422 EMPTY_INVOICE; with a line → issued (issue_date set)', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await jsonOf<Invoice>(await createInvoice(newInvoiceBody()))

    const empty = await issue(created.id, created.version)
    expect(empty.status).toBe(422)
    expect(await jsonOf<{ code: string }>(empty)).toMatchObject({ code: 'EMPTY_INVOICE' })

    await addLine(created.id, { description: 'License', quantity: '1', unitPrice: '500.00' })
    const withLine = await jsonOf<Invoice>(await getInvoice(created.id))
    const issued = await jsonOf<Invoice>(await issue(created.id, withLine.version))
    expect(issued.status).toBe('issued')
    expect(issued.issueDate).not.toBeNull()
  })

  it('(c) payment lifecycle: partial → partially_paid; overpay → 422 OVERPAYMENT (unchanged); exact → paid', async (ctx) => {
    if (!harness) return ctx.skip()
    const issued = await issuedInvoiceWithTotal('1000.00')
    expect(issued.total).toBe('1000.00')

    // partial 400.00 → partially_paid
    const partial = await jsonOf<{ invoiceId: string; amount: string }>(
      await pay(issued.id, '400.00')
    )
    expect(partial.amount).toBe('400.00')
    const afterPartial = await jsonOf<Invoice>(await getInvoice(issued.id))
    expect(afterPartial.status).toBe('partially_paid')
    expect(afterPartial.amountPaid).toBe('400.00')

    // overpay 700.00 (balance is 600.00) → 422 OVERPAYMENT, amount_paid unchanged
    const over = await pay(issued.id, '700.00')
    expect(over.status).toBe(422)
    expect(await jsonOf<{ code: string }>(over)).toMatchObject({ code: 'OVERPAYMENT' })
    const afterOver = await jsonOf<Invoice>(await getInvoice(issued.id))
    expect(afterOver.amountPaid).toBe('400.00')
    expect(afterOver.status).toBe('partially_paid')

    // exact balance 600.00 → paid
    await pay(issued.id, '600.00')
    const afterPaid = await jsonOf<Invoice>(await getInvoice(issued.id))
    expect(afterPaid.status).toBe('paid')
    expect(afterPaid.amountPaid).toBe('1000.00')

    const payments = await jsonOf<{ items: { amount: string }[] }>(
      await bearerFetch('owner', org(`/invoices/${issued.id}/payments`))
    )
    expect(payments.items.map((p) => p.amount).sort()).toEqual(['400.00', '600.00'])
  })

  it('(d) draft-only: add-line refused after issue (409); can only pay an issued/partially_paid invoice', async (ctx) => {
    if (!harness) return ctx.skip()
    const issued = await issuedInvoiceWithTotal('200.00')
    const refused = await addLine(issued.id, {
      description: 'Late add',
      quantity: '1',
      unitPrice: '10.00'
    })
    expect(refused.status).toBe(409)
    expect(await jsonOf<{ code: string }>(refused)).toMatchObject({ code: 'INVOICE_NOT_DRAFT' })

    // a draft invoice is not payable yet
    const draft = await jsonOf<Invoice>(await createInvoice(newInvoiceBody()))
    const notPayable = await pay(draft.id, '10.00')
    expect(notPayable.status).toBe(409)
    expect(await jsonOf<{ code: string }>(notPayable)).toMatchObject({
      code: 'INVOICE_NOT_PAYABLE'
    })
  })

  it('(e) OCC on invoice update: 428 without If-Match, 409 on stale version, 200 with current', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await jsonOf<Invoice>(
      await createInvoice(newInvoiceBody({ taxAmount: '0.00' }))
    )

    const noIfMatch = await bearerFetch('owner', org(`/invoices/${created.id}`), {
      method: 'PATCH',
      body: JSON.stringify({ taxAmount: '10.00' })
    })
    expect(noIfMatch.status).toBe(428)

    const ok = await bearerFetch('owner', org(`/invoices/${created.id}`), {
      method: 'PATCH',
      headers: { 'if-match': `"invoice-${created.version}"` },
      body: JSON.stringify({ taxAmount: '10.00' })
    })
    expect(ok.status).toBe(200)
    expect((await jsonOf<Invoice>(ok)).taxAmount).toBe('10.00')

    const stale = await bearerFetch('owner', org(`/invoices/${created.id}`), {
      method: 'PATCH',
      headers: { 'if-match': `"invoice-${created.version}"` },
      body: JSON.stringify({ taxAmount: '20.00' })
    })
    expect(stale.status).toBe(409)
  })

  it('(f) duplicate invoice number in the same org → 409', async (ctx) => {
    if (!harness) return ctx.skip()
    const number = `INV-DUP-${randomUUID().slice(0, 8)}`
    const first = await createInvoice(newInvoiceBody({ invoiceNumber: number }))
    expect(first.status).toBe(201)
    const dup = await createInvoice(newInvoiceBody({ invoiceNumber: number }))
    expect(dup.status).toBe(409)
  })

  it('(g) RBAC: a member without finance.invoice.manage cannot create an invoice (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const denied = await createInvoice(newInvoiceBody(), 'member')
    expect(denied.status).toBe(403)
  })

  it('(h) cross-tenant: another org owner cannot read this org invoice (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await jsonOf<Invoice>(await createInvoice(newInvoiceBody()))
    const denied = await bearerFetch('other', org(`/invoices/${created.id}`))
    expect(denied.status).toBe(403)
  })
})
