import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditFinanceEvent, emitFinanceResourceChange } from './finance-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R9 finance — the invoice aggregate. account_id / contract_id / project_id are OPAQUE cross-schema
// ids (no FK). subtotal/total are recomputed from the line items (total = subtotal + tax_amount);
// amount_paid is drawn down by payments. Money crosses the wire as a fixed-2 numeric STRING (mirrors
// crm contractValue) so a float can never round it. status walks draft → issued → partially_paid →
// paid | void; version is the OCC counter.

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void'

export type InvoiceResource = {
  id: string
  organizationId: string
  accountId: string
  contractId: string | null
  projectId: string | null
  invoiceNumber: string
  status: InvoiceStatus
  currency: string
  subtotal: string
  taxAmount: string
  total: string
  amountPaid: string
  issueDate: string | null
  dueDate: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type InvoiceRow = {
  id: string
  organization_id: string
  account_id: string
  contract_id: string | null
  project_id: string | null
  invoice_number: string
  status: string
  currency: string
  subtotal: string | number
  tax_amount: string | number
  total: string | number
  amount_paid: string | number
  issue_date: string | Date | null
  due_date: string | Date | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

// pg parses a bare `date` column into a Date at LOCAL midnight; read local Y-M-D so the wire value
// (contract format 'date') never drifts a day under a UTC-behind timezone.
function toDateString(value: string | Date | null): string | null {
  if (value === null) {
    return null
  }
  if (typeof value === 'string') {
    return value
  }
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function mapInvoice(row: InvoiceRow): InvoiceResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    contractId: row.contract_id,
    projectId: row.project_id,
    invoiceNumber: row.invoice_number,
    status: row.status as InvoiceStatus,
    currency: row.currency,
    subtotal: String(row.subtotal),
    taxAmount: String(row.tax_amount),
    total: String(row.total),
    amountPaid: String(row.amount_paid),
    issueDate: toDateString(row.issue_date),
    dueDate: toDateString(row.due_date),
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateInvoiceInput = {
  organizationId: string
  actorUserId: string
  accountId: string
  invoiceNumber: string
  contractId?: string | null
  projectId?: string | null
  currency?: string
  taxAmount?: string | number
  dueDate?: string | null
}

export type CreateInvoiceResult =
  | { ok: true; invoice: InvoiceResource }
  | { ok: false; reason: 'duplicate_number' }

/** Creates a draft invoice (subtotal/total = 0 until line items are added). */
export async function createInvoice(
  db: Kysely<Database>,
  input: CreateInvoiceInput
): Promise<CreateInvoiceResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const tax = input.taxAmount ?? 0
    const row = await trx
      .insertInto('finance.invoices')
      .values({
        organization_id: input.organizationId,
        account_id: input.accountId,
        contract_id: input.contractId ?? null,
        project_id: input.projectId ?? null,
        invoice_number: input.invoiceNumber,
        status: 'draft',
        currency: input.currency ?? 'KRW',
        subtotal: 0,
        // total starts at the tax_amount alone (no lines yet); recomputed as lines are added.
        tax_amount: tax,
        total: tax,
        amount_paid: 0,
        due_date: input.dueDate ?? null
      })
      .onConflict((oc) => oc.columns(['organization_id', 'invoice_number']).doNothing())
      .returningAll()
      .executeTakeFirst()
    if (!row) {
      return { ok: false, reason: 'duplicate_number' }
    }
    await auditFinanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'invoice.created',
      'invoice',
      row.id
    )
    await emitFinanceResourceChange(trx, input.organizationId, 'invoice', row.id, 1, 'created')
    return { ok: true, invoice: mapInvoice(row) }
  })
}

export async function getInvoice(
  db: Kysely<Database>,
  organizationId: string,
  invoiceId: string
): Promise<InvoiceResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('finance.invoices')
      .selectAll()
      .where('id', '=', invoiceId)
      .executeTakeFirst()
    return row ? mapInvoice(row) : null
  })
}

export type InvoicePage = { items: InvoiceResource[]; nextCursor: string | null }

/** Lists invoices, filterable by account, contract, project, and status. */
export async function listInvoices(
  db: Kysely<Database>,
  organizationId: string,
  options: {
    accountId?: string
    contractId?: string
    projectId?: string
    status?: InvoiceStatus
    limit?: number
    cursor?: string | null
  } = {}
): Promise<InvoicePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('finance.invoices')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.accountId) {
      query = query.where('account_id', '=', options.accountId)
    }
    if (options.contractId) {
      query = query.where('contract_id', '=', options.contractId)
    }
    if (options.projectId) {
      query = query.where('project_id', '=', options.projectId)
    }
    if (options.status) {
      query = query.where('status', '=', options.status)
    }
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapInvoice), nextCursor }
  })
}

export type UpdateInvoiceResult =
  | { ok: true; invoice: InvoiceResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'not_draft'; status: InvoiceStatus }

export type UpdateInvoiceInput = {
  organizationId: string
  invoiceId: string
  actorUserId: string
  expectedVersion: number
  contractId?: string | null
  projectId?: string | null
  currency?: string
  taxAmount?: string | number
  dueDate?: string | null
}

/** Edits invoice metadata under OCC (If-Match). Draft-only; changing tax recomputes the total. */
export async function updateInvoice(
  db: Kysely<Database>,
  input: UpdateInvoiceInput
): Promise<UpdateInvoiceResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('finance.invoices')
      .selectAll()
      .where('id', '=', input.invoiceId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    if (current.status !== 'draft') {
      return { ok: false, reason: 'not_draft', status: current.status as InvoiceStatus }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('finance.invoices')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.contractId === undefined ? {} : { contract_id: input.contractId }),
        ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.dueDate === undefined ? {} : { due_date: input.dueDate }),
        // total-recomputed-from-lines: a tax change re-derives total = subtotal + tax_amount.
        ...(input.taxAmount === undefined
          ? {}
          : { tax_amount: input.taxAmount, total: sql`subtotal + ${input.taxAmount}::numeric` })
      })
      .where('id', '=', input.invoiceId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditFinanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'invoice.updated',
      'invoice',
      updated.id
    )
    await emitFinanceResourceChange(
      trx,
      input.organizationId,
      'invoice',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, invoice: mapInvoice(updated) }
  })
}

// total-recomputed-from-lines: re-derives subtotal = Σ line amounts and total = subtotal + tax_amount,
// bumps version, and emits an invoice change. Runs inside the caller's tenant tx (the line-item store
// calls it after an add/remove) so the recompute is atomic with the line change.
export async function recomputeInvoiceTotals(
  trx: Transaction<Database>,
  organizationId: string,
  invoiceId: string
): Promise<InvoiceResource> {
  const agg = await trx
    .selectFrom('finance.invoice_line_items')
    .select(sql<string>`coalesce(sum(amount), 0)`.as('subtotal'))
    .where('invoice_id', '=', invoiceId)
    .executeTakeFirstOrThrow()
  const updated = await trx
    .updateTable('finance.invoices')
    .set({
      subtotal: agg.subtotal,
      total: sql`${agg.subtotal}::numeric + tax_amount`,
      version: sql`version + 1`,
      updated_at: sql`now()`
    })
    .where('id', '=', invoiceId)
    .returningAll()
    .executeTakeFirstOrThrow()
  await emitFinanceResourceChange(
    trx,
    organizationId,
    'invoice',
    invoiceId,
    Number(updated.version),
    'updated'
  )
  return mapInvoice(updated)
}

export type IssueInvoiceResult =
  | { ok: true; invoice: InvoiceResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'not_draft'; status: InvoiceStatus }
  | { ok: false; reason: 'empty_invoice' }

/**
 * Issues a draft invoice under OCC: refuses an EMPTY invoice (no line items), stamps issue_date, and
 * freezes the lines (subsequent add/remove are refused because status is no longer draft).
 */
export async function issueInvoice(
  db: Kysely<Database>,
  input: {
    organizationId: string
    invoiceId: string
    actorUserId: string
    expectedVersion: number
    issueDate?: string | null
  }
): Promise<IssueInvoiceResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('finance.invoices')
      .selectAll()
      .where('id', '=', input.invoiceId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    if (current.status !== 'draft') {
      return { ok: false, reason: 'not_draft', status: current.status as InvoiceStatus }
    }
    const lineCount = await trx
      .selectFrom('finance.invoice_line_items')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('invoice_id', '=', input.invoiceId)
      .executeTakeFirstOrThrow()
    if (lineCount.count === 0) {
      return { ok: false, reason: 'empty_invoice' }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('finance.invoices')
      .set({
        status: 'issued',
        issue_date: input.issueDate ?? sql`current_date`,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.invoiceId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditFinanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'invoice.issued',
      'invoice',
      updated.id
    )
    await emitFinanceResourceChange(
      trx,
      input.organizationId,
      'invoice',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, invoice: mapInvoice(updated) }
  })
}

export type VoidInvoiceResult =
  | { ok: true; invoice: InvoiceResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'already_terminal'; status: InvoiceStatus }

/** Voids an invoice under OCC. A paid or already-void invoice is terminal and cannot be voided. */
export async function voidInvoice(
  db: Kysely<Database>,
  input: {
    organizationId: string
    invoiceId: string
    actorUserId: string
    expectedVersion: number
  }
): Promise<VoidInvoiceResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('finance.invoices')
      .selectAll()
      .where('id', '=', input.invoiceId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    if (current.status === 'paid' || current.status === 'void') {
      return { ok: false, reason: 'already_terminal', status: current.status as InvoiceStatus }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('finance.invoices')
      .set({ status: 'void', version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.invoiceId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditFinanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'invoice.voided',
      'invoice',
      updated.id
    )
    await emitFinanceResourceChange(
      trx,
      input.organizationId,
      'invoice',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, invoice: mapInvoice(updated) }
  })
}
