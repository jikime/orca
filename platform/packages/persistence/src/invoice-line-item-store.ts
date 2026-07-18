import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditFinanceEvent, emitFinanceResourceChange } from './finance-resource-events'
import { recomputeInvoiceTotals, type InvoiceResource, type InvoiceStatus } from './invoice-store'
import { withTenantTransaction } from './tenant-transaction'

// R9 finance — invoice line items. invoice_id is a same-schema composite FK to the parent. amount =
// round(quantity * unit_price, 2), computed on write in the DB (exact numeric, never a float). Adding
// or removing a line recomputes the parent invoice subtotal/total — but only while the invoice is
// still draft (an issued invoice's lines are frozen). Money crosses the wire as a fixed-2 STRING.

export type InvoiceLineItemResource = {
  id: string
  organizationId: string
  invoiceId: string
  description: string
  quantity: string
  unitPrice: string
  amount: string
  sortOrder: number
  createdAt: string
}

type InvoiceLineItemRow = {
  id: string
  organization_id: string
  invoice_id: string
  description: string
  quantity: string | number
  unit_price: string | number
  amount: string | number
  sort_order: number
  created_at: Date | string
}

export function mapInvoiceLineItem(row: InvoiceLineItemRow): InvoiceLineItemResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    invoiceId: row.invoice_id,
    description: row.description,
    quantity: String(row.quantity),
    unitPrice: String(row.unit_price),
    amount: String(row.amount),
    sortOrder: Number(row.sort_order),
    createdAt: new Date(row.created_at).toISOString()
  }
}

export type AddLineItemResult =
  | { ok: true; lineItem: InvoiceLineItemResource; invoice: InvoiceResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_draft'; status: InvoiceStatus }

/** Adds a line item to a DRAFT invoice and recomputes the parent totals (atomic in one tenant tx). */
export async function addInvoiceLineItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    invoiceId: string
    description: string
    quantity?: string | number
    unitPrice?: string | number
    sortOrder?: number
  }
): Promise<AddLineItemResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const invoice = await trx
      .selectFrom('finance.invoices')
      .select(['id', 'status'])
      .where('id', '=', input.invoiceId)
      .forUpdate()
      .executeTakeFirst()
    if (!invoice) {
      return { ok: false, reason: 'not_found' }
    }
    if (invoice.status !== 'draft') {
      return { ok: false, reason: 'not_draft', status: invoice.status as InvoiceStatus }
    }
    const quantity = input.quantity ?? 1
    const unitPrice = input.unitPrice ?? 0
    const line = await trx
      .insertInto('finance.invoice_line_items')
      .values({
        organization_id: input.organizationId,
        invoice_id: input.invoiceId,
        description: input.description,
        quantity,
        unit_price: unitPrice,
        // amount computed on write: round(quantity * unit_price, 2), exact numeric.
        amount: sql`round(${quantity}::numeric * ${unitPrice}::numeric, 2)`,
        sort_order: input.sortOrder ?? 0
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const updatedInvoice = await recomputeInvoiceTotals(trx, input.organizationId, input.invoiceId)
    await auditFinanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'invoice.line_item.added',
      'invoice_line_item',
      line.id
    )
    await emitFinanceResourceChange(
      trx,
      input.organizationId,
      'invoice_line_item',
      line.id,
      1,
      'created'
    )
    return { ok: true, lineItem: mapInvoiceLineItem(line), invoice: updatedInvoice }
  })
}

export type RemoveLineItemResult =
  | { ok: true; invoice: InvoiceResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'line_not_found' }
  | { ok: false; reason: 'not_draft'; status: InvoiceStatus }

/** Removes a line item from a DRAFT invoice and recomputes the parent totals (atomic in one tenant tx). */
export async function removeInvoiceLineItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    invoiceId: string
    lineItemId: string
  }
): Promise<RemoveLineItemResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const invoice = await trx
      .selectFrom('finance.invoices')
      .select(['id', 'status'])
      .where('id', '=', input.invoiceId)
      .forUpdate()
      .executeTakeFirst()
    if (!invoice) {
      return { ok: false, reason: 'not_found' }
    }
    if (invoice.status !== 'draft') {
      return { ok: false, reason: 'not_draft', status: invoice.status as InvoiceStatus }
    }
    const deleted = await trx
      .deleteFrom('finance.invoice_line_items')
      .where('id', '=', input.lineItemId)
      .where('invoice_id', '=', input.invoiceId)
      .returning('id')
      .executeTakeFirst()
    if (!deleted) {
      return { ok: false, reason: 'line_not_found' }
    }
    const updatedInvoice = await recomputeInvoiceTotals(trx, input.organizationId, input.invoiceId)
    await auditFinanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'invoice.line_item.removed',
      'invoice_line_item',
      deleted.id
    )
    await emitFinanceResourceChange(
      trx,
      input.organizationId,
      'invoice_line_item',
      deleted.id,
      1,
      'deleted'
    )
    return { ok: true, invoice: updatedInvoice }
  })
}

export type InvoiceLineItemPage = {
  items: InvoiceLineItemResource[]
  nextCursor: string | null
}

/** Lists an invoice's line items in display order (sort_order asc, id asc for a stable tiebreak). */
export async function listInvoiceLineItems(
  db: Kysely<Database>,
  organizationId: string,
  invoiceId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<InvoiceLineItemPage> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('finance.invoice_line_items')
      .selectAll()
      .where('invoice_id', '=', invoiceId)
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapInvoiceLineItem), nextCursor }
  })
}
