import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditFinanceEvent, emitFinanceResourceChange } from './finance-resource-events'
import { mapInvoice, type InvoiceResource, type InvoiceStatus } from './invoice-store'
import { withTenantTransaction } from './tenant-transaction'

// R9 finance — append-only payments. Recording a payment draws down the invoice outstanding balance
// (total − amount_paid) and walks its status issued → partially_paid → paid. The balance check and the
// amount_paid increment happen under a SINGLE row lock (forUpdate) so two concurrent payments can never
// overpay; an amount exceeding the outstanding balance is refused BEFORE any write (no partial apply),
// so a payment row exists only for money actually applied. Money crosses the wire as a fixed-2 STRING.

export type PaymentMethod = 'bank_transfer' | 'card' | 'cash' | 'other'

export type PaymentResource = {
  id: string
  organizationId: string
  invoiceId: string
  amount: string
  paidAt: string
  method: PaymentMethod
  reference: string | null
  recordedBy: string | null
  createdAt: string
}

type PaymentRow = {
  id: string
  organization_id: string
  invoice_id: string
  amount: string | number
  paid_at: Date | string
  method: string
  reference: string | null
  recorded_by: string | null
  created_at: Date | string
}

export function mapPayment(row: PaymentRow): PaymentResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    invoiceId: row.invoice_id,
    amount: String(row.amount),
    paidAt: new Date(row.paid_at).toISOString(),
    method: row.method as PaymentMethod,
    reference: row.reference,
    recordedBy: row.recorded_by,
    createdAt: new Date(row.created_at).toISOString()
  }
}

export type RecordPaymentResult =
  | { ok: true; payment: PaymentResource; invoice: InvoiceResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_status'; status: InvoiceStatus }
  | { ok: false; reason: 'overpayment'; outstanding: string }

/**
 * Records a payment against an issued/partially_paid invoice. payment-atomic-balance-check: the invoice
 * row is locked, the outstanding balance is checked, and amount_paid is incremented in the same tx;
 * overpayment-refused: an amount over the balance returns without writing anything.
 */
export async function recordPayment(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    invoiceId: string
    amount: string | number
    method?: PaymentMethod
    reference?: string | null
    paidAt?: string | null
  }
): Promise<RecordPaymentResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('finance.invoices')
      .select(['status', sql<string>`(total - amount_paid)`.as('outstanding')])
      .where('id', '=', input.invoiceId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    if (current.status !== 'issued' && current.status !== 'partially_paid') {
      return { ok: false, reason: 'invalid_status', status: current.status as InvoiceStatus }
    }
    const amount = input.amount
    // overpayment-refused: guard the increment on outstanding ≥ amount, checked exactly in the DB
    // (numeric, not float) under the row lock; 0 rows updated ⇒ the amount exceeds the balance.
    const updated = await trx
      .updateTable('finance.invoices')
      .set({
        amount_paid: sql`round(amount_paid + ${amount}::numeric, 2)`,
        status: sql`case when amount_paid + ${amount}::numeric >= total then 'paid' else 'partially_paid' end`,
        version: sql`version + 1`,
        updated_at: sql`now()`
      })
      .where('id', '=', input.invoiceId)
      .where(sql<boolean>`total - amount_paid >= ${amount}::numeric`)
      .returningAll()
      .executeTakeFirst()
    if (!updated) {
      return { ok: false, reason: 'overpayment', outstanding: current.outstanding }
    }
    const payment = await trx
      .insertInto('finance.payments')
      .values({
        organization_id: input.organizationId,
        invoice_id: input.invoiceId,
        amount,
        method: input.method ?? 'bank_transfer',
        reference: input.reference ?? null,
        recorded_by: input.actorUserId,
        ...(input.paidAt ? { paid_at: input.paidAt } : {})
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditFinanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'payment.recorded',
      'payment',
      payment.id
    )
    await emitFinanceResourceChange(trx, input.organizationId, 'payment', payment.id, 1, 'created')
    // The invoice status/amount_paid moved with the payment — invalidate it too.
    await emitFinanceResourceChange(
      trx,
      input.organizationId,
      'invoice',
      input.invoiceId,
      Number(updated.version),
      'updated'
    )
    return { ok: true, payment: mapPayment(payment), invoice: mapInvoice(updated) }
  })
}

export type PaymentPage = { items: PaymentResource[]; nextCursor: string | null }

/** Lists an invoice's payments, newest first (paid_at desc, id desc for a stable tiebreak). */
export async function listPaymentsByInvoice(
  db: Kysely<Database>,
  organizationId: string,
  invoiceId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<PaymentPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('finance.payments')
      .selectAll()
      .where('invoice_id', '=', invoiceId)
      .orderBy('paid_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '<', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapPayment), nextCursor }
  })
}
