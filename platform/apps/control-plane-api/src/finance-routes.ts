import {
  addInvoiceLineItem,
  createInvoice,
  getInvoice,
  issueInvoice,
  listInvoiceLineItems,
  listInvoices,
  listPaymentsByInvoice,
  recordPayment,
  removeInvoiceLineItem,
  updateInvoice,
  voidInvoice,
  type InvoiceResource,
  type InvoiceStatus,
  type PaymentMethod,
  type PaymentResource,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const SCHEMA = {
  invoice: 'https://schemas.pielab.ai/resources/invoice.v1.schema.json',
  invoiceCreate: 'https://schemas.pielab.ai/resources/invoice-create.v1.schema.json',
  invoiceUpdate: 'https://schemas.pielab.ai/resources/invoice-update.v1.schema.json',
  invoiceIssue: 'https://schemas.pielab.ai/resources/invoice-issue.v1.schema.json',
  lineItem: 'https://schemas.pielab.ai/resources/invoice-line-item.v1.schema.json',
  lineItemCreate: 'https://schemas.pielab.ai/resources/invoice-line-item-create.v1.schema.json',
  payment: 'https://schemas.pielab.ai/resources/payment.v1.schema.json',
  paymentCreate: 'https://schemas.pielab.ai/resources/payment-create.v1.schema.json'
} as const

const FINANCE_READ = 'finance.invoice.read'
const FINANCE_MANAGE = 'finance.invoice.manage'
const PAYMENT_RECORD = 'finance.payment.record'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'void'
]

export type FinanceRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

// Splits `<id>:<action>` (custom method), mirroring asset / governance action routes.
function parseTarget(target: string): { id: string; action: string } {
  const colon = target.lastIndexOf(':')
  return {
    id: colon === -1 ? target : target.slice(0, colon),
    action: colon === -1 ? '' : target.slice(colon + 1)
  }
}

// A money input is valid only when it parses to a finite number within the given bound (the DB
// numeric(14,2) check constraints reject the rest — we refuse early with a clean 422).
function isNonNegativeMoney(value: unknown): boolean {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0
}

function isPositiveMoney(value: unknown): boolean {
  const n = Number(value)
  return Number.isFinite(n) && n > 0
}

async function guard(
  deps: FinanceRoutesDeps,
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

export function registerFinanceRoutes(app: FastifyInstance, deps: FinanceRoutesDeps): void {
  registerInvoiceCrudRoutes(app, deps)
  registerInvoiceLineItemRoutes(app, deps)
  registerPaymentRoutes(app, deps)
}

// === invoices: create(draft) / list / get / update(OCC, draft-only) / :issue / :void ===
function registerInvoiceCrudRoutes(app: FastifyInstance, deps: FinanceRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/invoices', (request, reply) =>
    createInvoiceHandler(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/invoices', async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }
    const auth = await guard(deps, app, request, reply, organizationId, FINANCE_READ)
    if (!auth) return reply
    const query = request.query as {
      accountId?: string
      contractId?: string
      projectId?: string
      status?: string
      cursor?: string
    }
    if (query.status !== undefined && !INVOICE_STATUSES.includes(query.status as InvoiceStatus))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid status filter')
    const page = await listInvoices(deps.db, organizationId, {
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.contractId ? { contractId: query.contractId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status ? { status: query.status as InvoiceStatus } : {}),
      cursor: query.cursor ?? null
    })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.invoice, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
  app.get('/v1/organizations/:organizationId/invoices/:invoiceId', async (request, reply) => {
    const { organizationId, invoiceId } = request.params as {
      organizationId: string
      invoiceId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, FINANCE_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(invoiceId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const invoice = await getInvoice(deps.db, organizationId, invoiceId)
    if (!invoice) return problem(reply, request, 404, 'NOT_FOUND', 'invoice not found')
    assertResponse(deps.registry, SCHEMA.invoice, invoice)
    void reply.header('etag', etag('invoice', invoice.version))
    return invoice
  })
  app.patch('/v1/organizations/:organizationId/invoices/:invoiceId', (request, reply) =>
    updateInvoiceHandler(app, deps, request, reply)
  )
  app.post('/v1/organizations/:organizationId/invoices/:invoiceTarget', (request, reply) =>
    invoiceActionHandler(app, deps, request, reply)
  )
}

async function createInvoiceHandler(
  app: FastifyInstance,
  deps: FinanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId } = request.params as { organizationId: string }
  const auth = await guard(deps, app, request, reply, organizationId, FINANCE_MANAGE)
  if (!auth) return reply
  if (!validates(deps.registry, SCHEMA.invoiceCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid invoice create')
  const body = request.body as {
    accountId: string
    contractId?: string
    projectId?: string
    invoiceNumber: string
    currency?: string
    taxAmount?: string | number
    dueDate?: string
  }
  if (body.taxAmount !== undefined && !isNonNegativeMoney(body.taxAmount))
    return problem(reply, request, 422, 'INVALID_AMOUNT', 'taxAmount must be a non-negative number')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/invoices'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (invoice: InvoiceResource): InvoiceResource => {
    assertResponse(deps.registry, SCHEMA.invoice, invoice)
    void reply
      .code(201)
      .header('etag', etag('invoice', invoice.version))
      .header('location', `/v1/organizations/${organizationId}/invoices/${invoice.id}`)
    return invoice
  }
  if (gate.priorResourceId) {
    const existing = await getInvoice(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const result = await createInvoice(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    accountId: body.accountId,
    invoiceNumber: body.invoiceNumber,
    contractId: body.contractId ?? null,
    projectId: body.projectId ?? null,
    ...(body.currency ? { currency: body.currency } : {}),
    ...(body.taxAmount === undefined ? {} : { taxAmount: body.taxAmount }),
    dueDate: body.dueDate ?? null
  })
  if (!result.ok) {
    await gate.release()
    return problem(reply, request, 409, 'DUPLICATE_INVOICE_NUMBER', 'invoice number already exists')
  }
  await gate.complete(result.invoice.id)
  return respond(result.invoice)
}

async function updateInvoiceHandler(
  app: FastifyInstance,
  deps: FinanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, invoiceId } = request.params as {
    organizationId: string
    invoiceId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, FINANCE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(invoiceId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.invoiceUpdate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid invoice update')
  const body = (request.body ?? {}) as {
    contractId?: string | null
    projectId?: string | null
    currency?: string
    taxAmount?: string | number
    dueDate?: string | null
  }
  if (body.taxAmount !== undefined && !isNonNegativeMoney(body.taxAmount))
    return problem(reply, request, 422, 'INVALID_AMOUNT', 'taxAmount must be a non-negative number')
  const expectedVersion = ifMatchVersion(request, 'invoice')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const result = await updateInvoice(deps.db, {
    organizationId,
    invoiceId,
    actorUserId: auth.userId,
    expectedVersion,
    ...body
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'invoice not found')
    if (result.reason === 'not_draft')
      return problem(reply, request, 409, 'INVOICE_NOT_DRAFT', 'only a draft invoice can be edited')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'invoice modified concurrently')
  }
  assertResponse(deps.registry, SCHEMA.invoice, result.invoice)
  void reply.header('etag', etag('invoice', result.invoice.version))
  return result.invoice
}

// Custom methods on an invoice: `<id>:issue` (draft→issued, refuses empty) and `<id>:void`.
async function invoiceActionHandler(
  app: FastifyInstance,
  deps: FinanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, invoiceTarget } = request.params as {
    organizationId: string
    invoiceTarget: string
  }
  const { id, action } = parseTarget(invoiceTarget)
  if (action !== 'issue' && action !== 'void')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown invoice action')
  const auth = await guard(deps, app, request, reply, organizationId, FINANCE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(id)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  const expectedVersion = ifMatchVersion(request, 'invoice')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  if (action === 'issue')
    return issueInvoiceHandler(
      deps,
      request,
      reply,
      organizationId,
      id,
      auth.userId,
      expectedVersion
    )
  return voidInvoiceHandler(deps, reply, request, organizationId, id, auth.userId, expectedVersion)
}

async function issueInvoiceHandler(
  deps: FinanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  invoiceId: string,
  actorUserId: string,
  expectedVersion: number
): Promise<unknown> {
  if (!validates(deps.registry, SCHEMA.invoiceIssue, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid issue request')
  const issueDate = (request.body as { issueDate?: string } | undefined)?.issueDate
  const result = await issueInvoice(deps.db, {
    organizationId,
    invoiceId,
    actorUserId,
    expectedVersion,
    ...(issueDate ? { issueDate } : {})
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'invoice not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'invoice modified concurrently')
    if (result.reason === 'not_draft')
      return problem(reply, request, 409, 'INVOICE_NOT_DRAFT', 'only a draft invoice can be issued')
    // an invoice with no line items cannot be issued
    return problem(
      reply,
      request,
      422,
      'EMPTY_INVOICE',
      'cannot issue an invoice with no line items'
    )
  }
  assertResponse(deps.registry, SCHEMA.invoice, result.invoice)
  void reply.header('etag', etag('invoice', result.invoice.version))
  return result.invoice
}

async function voidInvoiceHandler(
  deps: FinanceRoutesDeps,
  reply: FastifyReply,
  request: FastifyRequest,
  organizationId: string,
  invoiceId: string,
  actorUserId: string,
  expectedVersion: number
): Promise<unknown> {
  const result = await voidInvoice(deps.db, {
    organizationId,
    invoiceId,
    actorUserId,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'invoice not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'invoice modified concurrently')
    return problem(
      reply,
      request,
      409,
      'INVOICE_TERMINAL',
      `cannot void a ${result.status} invoice`
    )
  }
  assertResponse(deps.registry, SCHEMA.invoice, result.invoice)
  void reply.header('etag', etag('invoice', result.invoice.version))
  return result.invoice
}

// === line items: add (draft-only, recomputes totals) / list / remove (draft-only, recomputes) ===
function registerInvoiceLineItemRoutes(app: FastifyInstance, deps: FinanceRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/invoices/:invoiceId/line-items', (request, reply) =>
    addLineItemHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/invoices/:invoiceId/line-items',
    async (request, reply) => {
      const { organizationId, invoiceId } = request.params as {
        organizationId: string
        invoiceId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, FINANCE_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(invoiceId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const { cursor } = request.query as { cursor?: string }
      const page = await listInvoiceLineItems(deps.db, organizationId, invoiceId, {
        cursor: cursor ?? null
      })
      for (const item of page.items) assertResponse(deps.registry, SCHEMA.lineItem, item)
      return { items: page.items, nextCursor: page.nextCursor }
    }
  )
  app.delete(
    '/v1/organizations/:organizationId/invoices/:invoiceId/line-items/:lineItemId',
    (request, reply) => removeLineItemHandler(app, deps, request, reply)
  )
}

async function addLineItemHandler(
  app: FastifyInstance,
  deps: FinanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, invoiceId } = request.params as {
    organizationId: string
    invoiceId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, FINANCE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(invoiceId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.lineItemCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid line item')
  const body = request.body as {
    description: string
    quantity?: string | number
    unitPrice?: string | number
    sortOrder?: number
  }
  if (body.quantity !== undefined && !isNonNegativeMoney(body.quantity))
    return problem(reply, request, 422, 'INVALID_AMOUNT', 'quantity must be a non-negative number')
  if (body.unitPrice !== undefined && !isNonNegativeMoney(body.unitPrice))
    return problem(reply, request, 422, 'INVALID_AMOUNT', 'unitPrice must be a non-negative number')
  const result = await addInvoiceLineItem(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    invoiceId,
    description: body.description,
    ...(body.quantity === undefined ? {} : { quantity: body.quantity }),
    ...(body.unitPrice === undefined ? {} : { unitPrice: body.unitPrice }),
    ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder })
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'invoice not found')
    return problem(
      reply,
      request,
      409,
      'INVOICE_NOT_DRAFT',
      'line items can only be added to a draft invoice'
    )
  }
  assertResponse(deps.registry, SCHEMA.lineItem, result.lineItem)
  void reply
    .code(201)
    .header('etag', etag('invoice', result.invoice.version))
    .header(
      'location',
      `/v1/organizations/${organizationId}/invoices/${invoiceId}/line-items/${result.lineItem.id}`
    )
  return result.lineItem
}

async function removeLineItemHandler(
  app: FastifyInstance,
  deps: FinanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, invoiceId, lineItemId } = request.params as {
    organizationId: string
    invoiceId: string
    lineItemId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, FINANCE_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(invoiceId) || !UUID_PATTERN.test(lineItemId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  const result = await removeInvoiceLineItem(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    invoiceId,
    lineItemId
  })
  if (!result.ok) {
    if (result.reason === 'not_found' || result.reason === 'line_not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'line item not found')
    return problem(
      reply,
      request,
      409,
      'INVOICE_NOT_DRAFT',
      'line items can only be removed from a draft invoice'
    )
  }
  void reply.header('etag', etag('invoice', result.invoice.version))
  return result.invoice
}

// === payments: record (atomic balance draw-down, refuses overpayment) / list-by-invoice ===
function registerPaymentRoutes(app: FastifyInstance, deps: FinanceRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/invoices/:invoiceId/payments', (request, reply) =>
    recordPaymentHandler(app, deps, request, reply)
  )
  app.get(
    '/v1/organizations/:organizationId/invoices/:invoiceId/payments',
    async (request, reply) => {
      const { organizationId, invoiceId } = request.params as {
        organizationId: string
        invoiceId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, FINANCE_READ)
      if (!auth) return reply
      if (!UUID_PATTERN.test(invoiceId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const { cursor } = request.query as { cursor?: string }
      const page = await listPaymentsByInvoice(deps.db, organizationId, invoiceId, {
        cursor: cursor ?? null
      })
      for (const item of page.items) assertResponse(deps.registry, SCHEMA.payment, item)
      return { items: page.items, nextCursor: page.nextCursor }
    }
  )
}

async function recordPaymentHandler(
  app: FastifyInstance,
  deps: FinanceRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, invoiceId } = request.params as {
    organizationId: string
    invoiceId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, PAYMENT_RECORD)
  if (!auth) return reply
  if (!UUID_PATTERN.test(invoiceId))
    return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.paymentCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid payment')
  const body = request.body as {
    amount: string | number
    method?: PaymentMethod
    reference?: string
    paidAt?: string
  }
  if (!isPositiveMoney(body.amount))
    return problem(reply, request, 422, 'INVALID_AMOUNT', 'amount must be a positive number')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/invoices/{invoiceId}/payments'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (payment: PaymentResource): PaymentResource => {
    assertResponse(deps.registry, SCHEMA.payment, payment)
    void reply
      .code(201)
      .header(
        'location',
        `/v1/organizations/${organizationId}/invoices/${invoiceId}/payments/${payment.id}`
      )
    return payment
  }
  const result = await recordPayment(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    invoiceId,
    amount: body.amount,
    ...(body.method ? { method: body.method } : {}),
    ...(body.reference ? { reference: body.reference } : {}),
    ...(body.paidAt ? { paidAt: body.paidAt } : {})
  })
  if (!result.ok) {
    await gate.release()
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'invoice not found')
    if (result.reason === 'invalid_status')
      return problem(
        reply,
        request,
        409,
        'INVOICE_NOT_PAYABLE',
        `cannot record a payment on a ${result.status} invoice`
      )
    // an amount exceeding the outstanding balance is refused with no partial apply
    return problem(reply, request, 422, 'OVERPAYMENT', 'amount exceeds the outstanding balance')
  }
  await gate.complete(result.payment.id)
  return respond(result.payment)
}
