import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeResourceType
} from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 1, the load-bearing exit condition: "계약 범위와 변경 범위를 구분하고 승인 전 실행을
// 제한한다." The contract carries a BASE scope; a change order carries a DISTINCT change scope.
// The EFFECTIVE scope = base + the deltas of APPROVED change orders only, and execution (project
// creation) is refused unless the contract is approved. Both invariants live in this file.

export type ContractApprovalStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'changed'

export type ChangeOrderApprovalStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected'
export type ScopeChangeKind = 'add' | 'remove' | 'modify'

export type ScopeItemInput = {
  serviceType: string
  description?: string | null
  quantity?: number | string
  rate?: number | string
  sortKey?: number
}

export type ContractScopeItem = {
  id: string
  serviceType: string
  description: string | null
  quantity: string
  rate: string
  sortKey: number
}

export type ChangeOrderScopeItem = ContractScopeItem & { changeKind: ScopeChangeKind }

export type ContractResource = {
  id: string
  organizationId: string
  accountId: string
  title: string
  contractValue: string
  approvalStatus: ContractApprovalStatus
  effectiveStart: string | null
  effectiveEnd: string | null
  submittedBy: string | null
  approvedBy: string | null
  approvedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type ChangeOrderResource = {
  id: string
  organizationId: string
  contractId: string
  title: string
  approvalStatus: ChangeOrderApprovalStatus
  valueDelta: string
  submittedBy: string | null
  customerApproverUserId: string | null
  approvedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

// The effective scope read-model: base items always, plus the delta items of every APPROVED
// change order. An unapproved change order contributes NOTHING (no execution before approval).
export type EffectiveScope = {
  contract: ContractResource
  baseItems: ContractScopeItem[]
  appliedChangeOrders: { changeOrderId: string; items: ChangeOrderScopeItem[] }[]
  effectiveItems: (ContractScopeItem & {
    source: 'base' | 'change_order'
    changeOrderId?: string
  })[]
}

// A contract is EXECUTABLE only when approved (or approved-then-amended). This is the single
// predicate the execution gate consults — no project is created against a non-approved contract.
export function isContractExecutable(status: ContractApprovalStatus): boolean {
  return status === 'approved' || status === 'changed'
}

function mapContract(row: {
  id: string
  organization_id: string
  account_id: string
  title: string
  contract_value: string | number
  approval_status: string
  effective_start: string | null
  effective_end: string | null
  submitted_by: string | null
  approved_by: string | null
  approved_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}): ContractResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    title: row.title,
    contractValue: String(row.contract_value),
    approvalStatus: row.approval_status as ContractApprovalStatus,
    effectiveStart: row.effective_start,
    effectiveEnd: row.effective_end,
    submittedBy: row.submitted_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

function mapChangeOrder(row: {
  id: string
  organization_id: string
  contract_id: string
  title: string
  approval_status: string
  value_delta: string | number
  submitted_by: string | null
  customer_approver_user_id: string | null
  approved_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}): ChangeOrderResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    contractId: row.contract_id,
    title: row.title,
    approvalStatus: row.approval_status as ChangeOrderApprovalStatus,
    valueDelta: String(row.value_delta),
    submittedBy: row.submitted_by,
    customerApproverUserId: row.customer_approver_user_id,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

function mapScopeItem(row: {
  id: string
  service_type: string
  description: string | null
  quantity: string | number
  rate: string | number
  sort_key: number
}): ContractScopeItem {
  return {
    id: row.id,
    serviceType: row.service_type,
    description: row.description,
    quantity: String(row.quantity),
    rate: String(row.rate),
    sortKey: row.sort_key
  }
}

async function emitCrmChange(
  trx: Transaction<Database>,
  organizationId: string,
  resourceType: ResourceChangeResourceType,
  resourceId: string,
  version: number,
  changeKind: 'created' | 'updated'
): Promise<void> {
  const outboxId = randomUUID()
  const occurredAt = new Date().toISOString()
  const cloudEvent = buildResourceChangeCloudEvent({
    organizationId,
    eventId: outboxId,
    resourceType,
    resourceId,
    changeKind,
    version,
    occurredAt
  })
  await trx
    .insertInto('operations.outbox_events')
    .values({
      id: outboxId,
      organization_id: organizationId,
      aggregate_type: resourceType,
      aggregate_id: resourceId,
      aggregate_version: version,
      event_type: cloudEvent.type,
      event_schema_version: 1,
      payload: JSON.stringify(cloudEvent),
      occurred_at: occurredAt,
      available_at: occurredAt
    })
    .execute()
}

async function audit(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorUserId,
      action,
      target_type: targetType,
      target_id: targetId
    })
    .execute()
}

export type CreateContractResult =
  | { ok: true; contract: ContractResource; scopeItems: ContractScopeItem[] }
  | { ok: false; reason: 'account_not_found' }

/**
 * Creates a contract in status='draft' with its BASE scope line items, all in one tenant tx.
 * A draft contract is NOT executable — it must pass submit → approve first.
 */
export async function createContract(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    accountId: string
    title: string
    contractValue?: number | string
    effectiveStart?: string | null
    effectiveEnd?: string | null
    scopeItems?: ScopeItemInput[]
  }
): Promise<CreateContractResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const account = await trx
      .selectFrom('crm.accounts')
      .select('id')
      .where('id', '=', input.accountId)
      .executeTakeFirst()
    if (!account) {
      return { ok: false, reason: 'account_not_found' }
    }
    const contract = await trx
      .insertInto('crm.contracts')
      .values({
        organization_id: input.organizationId,
        account_id: input.accountId,
        title: input.title,
        contract_value: input.contractValue ?? 0,
        approval_status: 'draft',
        effective_start: input.effectiveStart ?? null,
        effective_end: input.effectiveEnd ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const scopeItems = await insertScopeItems(
      trx,
      input.organizationId,
      contract.id,
      input.scopeItems ?? []
    )
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'crm.contract.created',
      'crm_contract',
      contract.id
    )
    await emitCrmChange(trx, input.organizationId, 'crm_contract', contract.id, 1, 'created')
    return { ok: true, contract: mapContract(contract), scopeItems }
  })
}

async function insertScopeItems(
  trx: Transaction<Database>,
  organizationId: string,
  contractId: string,
  items: ScopeItemInput[]
): Promise<ContractScopeItem[]> {
  const inserted: ContractScopeItem[] = []
  for (const [index, item] of items.entries()) {
    const row = await trx
      .insertInto('crm.contract_scope_items')
      .values({
        organization_id: organizationId,
        contract_id: contractId,
        service_type: item.serviceType,
        description: item.description ?? null,
        quantity: item.quantity ?? 1,
        rate: item.rate ?? 0,
        sort_key: item.sortKey ?? index
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    inserted.push(mapScopeItem(row))
  }
  return inserted
}

export async function getContract(
  db: Kysely<Database>,
  organizationId: string,
  contractId: string
): Promise<ContractResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('crm.contracts')
      .selectAll()
      .where('id', '=', contractId)
      .executeTakeFirst()
    return row ? mapContract(row) : null
  })
}

export type ContractPage = { items: ContractResource[]; nextCursor: string | null }

export async function listContracts(
  db: Kysely<Database>,
  organizationId: string,
  options: { accountId?: string; limit?: number; cursor?: string | null } = {}
): Promise<ContractPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('crm.contracts')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.accountId) {
      query = query.where('account_id', '=', options.accountId)
    }
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapContract), nextCursor }
  })
}

export type ContractTransitionResult =
  | { ok: true; contract: ContractResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: ContractApprovalStatus }

// Legal approval-status edges: draft → pending_approval (submit); pending_approval → approved
// or rejected (the approval decision). 'changed' is reached only via an approved change order,
// never by a direct transition here.
async function applyContractDecision(
  db: Kysely<Database>,
  input: {
    organizationId: string
    contractId: string
    actorUserId: string
    action: 'submit' | 'approve' | 'reject'
    expectedVersion: number
  }
): Promise<ContractTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('crm.contracts')
      .selectAll()
      .where('id', '=', input.contractId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.approval_status as ContractApprovalStatus
    const legalFrom: Record<string, ContractApprovalStatus> = {
      submit: 'draft',
      approve: 'pending_approval',
      reject: 'pending_approval'
    }
    if (from !== legalFrom[input.action]) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const toByAction: Record<string, ContractApprovalStatus> = {
      submit: 'pending_approval',
      approve: 'approved',
      reject: 'rejected'
    }
    const toStatus = toByAction[input.action] ?? 'draft'
    const newVersion = currentVersion + 1
    const isApprove = input.action === 'approve'
    const updated = await trx
      .updateTable('crm.contracts')
      .set({
        approval_status: toStatus,
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.action === 'submit' ? { submitted_by: input.actorUserId } : {}),
        // Record WHO approved and WHEN so the approver is auditable (doc 13:289 snapshot).
        ...(isApprove ? { approved_by: input.actorUserId, approved_at: sql`now()` } : {})
      })
      .where('id', '=', input.contractId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `crm.contract.${input.action}`,
      'crm_contract',
      input.contractId
    )
    await emitCrmChange(
      trx,
      input.organizationId,
      'crm_contract',
      input.contractId,
      newVersion,
      'updated'
    )
    return { ok: true, contract: mapContract(updated) }
  })
}

export function submitContractForApproval(
  db: Kysely<Database>,
  input: {
    organizationId: string
    contractId: string
    actorUserId: string
    expectedVersion: number
  }
): Promise<ContractTransitionResult> {
  return applyContractDecision(db, { ...input, action: 'submit' })
}

export function approveContract(
  db: Kysely<Database>,
  input: {
    organizationId: string
    contractId: string
    actorUserId: string
    expectedVersion: number
  }
): Promise<ContractTransitionResult> {
  return applyContractDecision(db, { ...input, action: 'approve' })
}

export function rejectContract(
  db: Kysely<Database>,
  input: {
    organizationId: string
    contractId: string
    actorUserId: string
    expectedVersion: number
  }
): Promise<ContractTransitionResult> {
  return applyContractDecision(db, { ...input, action: 'reject' })
}

export type CreateChangeOrderResult =
  | { ok: true; changeOrder: ChangeOrderResource; scopeItems: ChangeOrderScopeItem[] }
  | { ok: false; reason: 'contract_not_found' }

/**
 * Creates a change order in status='draft' with its DISTINCT change-scope delta items — stored in
 * a separate table from the contract's base scope. The delta stays OUT of the effective scope
 * until the change order is approved.
 */
export async function createChangeOrder(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    contractId: string
    title: string
    valueDelta?: number | string
    scopeItems?: (ScopeItemInput & { changeKind?: ScopeChangeKind })[]
  }
): Promise<CreateChangeOrderResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const contract = await trx
      .selectFrom('crm.contracts')
      .select('id')
      .where('id', '=', input.contractId)
      .executeTakeFirst()
    if (!contract) {
      return { ok: false, reason: 'contract_not_found' }
    }
    const changeOrder = await trx
      .insertInto('crm.change_orders')
      .values({
        organization_id: input.organizationId,
        contract_id: input.contractId,
        title: input.title,
        value_delta: input.valueDelta ?? 0,
        approval_status: 'draft'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const scopeItems: ChangeOrderScopeItem[] = []
    for (const [index, item] of (input.scopeItems ?? []).entries()) {
      const row = await trx
        .insertInto('crm.change_order_scope_items')
        .values({
          organization_id: input.organizationId,
          change_order_id: changeOrder.id,
          change_kind: item.changeKind ?? 'add',
          service_type: item.serviceType,
          description: item.description ?? null,
          quantity: item.quantity ?? 1,
          rate: item.rate ?? 0,
          sort_key: item.sortKey ?? index
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      scopeItems.push({ ...mapScopeItem(row), changeKind: row.change_kind as ScopeChangeKind })
    }
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'crm.change_order.created',
      'crm_change_order',
      changeOrder.id
    )
    await emitCrmChange(trx, input.organizationId, 'crm_change_order', changeOrder.id, 1, 'created')
    return { ok: true, changeOrder: mapChangeOrder(changeOrder), scopeItems }
  })
}

export async function getChangeOrder(
  db: Kysely<Database>,
  organizationId: string,
  changeOrderId: string
): Promise<ChangeOrderResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('crm.change_orders')
      .selectAll()
      .where('id', '=', changeOrderId)
      .executeTakeFirst()
    return row ? mapChangeOrder(row) : null
  })
}

export type ChangeOrderDecisionResult =
  | { ok: true; changeOrder: ChangeOrderResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: ChangeOrderApprovalStatus }

/**
 * Approves or rejects a change order under OCC. Approval is the moment the delta becomes part of
 * the effective scope — before it, the change scope is inert. When a change order is approved
 * against an already-approved contract, the contract moves to 'changed' (still executable) so its
 * effective scope now differs from the originally approved base. Records the customer approver.
 */
export async function decideChangeOrder(
  db: Kysely<Database>,
  input: {
    organizationId: string
    changeOrderId: string
    actorUserId: string
    action: 'approve' | 'reject'
    expectedVersion: number
  }
): Promise<ChangeOrderDecisionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('crm.change_orders')
      .selectAll()
      .where('id', '=', input.changeOrderId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.approval_status as ChangeOrderApprovalStatus
    // A change order may be decided from draft or pending_approval; a terminal one cannot.
    if (from === 'approved' || from === 'rejected') {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const toStatus: ChangeOrderApprovalStatus = input.action === 'approve' ? 'approved' : 'rejected'
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('crm.change_orders')
      .set({
        approval_status: toStatus,
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.action === 'approve'
          ? { customer_approver_user_id: input.actorUserId, approved_at: sql`now()` }
          : {})
      })
      .where('id', '=', input.changeOrderId)
      .returningAll()
      .executeTakeFirstOrThrow()
    if (input.action === 'approve') {
      // An approved change order amends an approved contract → 'changed' (executable but no longer
      // the pristine base). If the contract is still in draft/pending, leave its status untouched.
      await trx
        .updateTable('crm.contracts')
        .set({ approval_status: 'changed', version: sql`version + 1`, updated_at: sql`now()` })
        .where('id', '=', current.contract_id)
        .where('approval_status', '=', 'approved')
        .execute()
    }
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `crm.change_order.${input.action}`,
      'crm_change_order',
      input.changeOrderId
    )
    await emitCrmChange(
      trx,
      input.organizationId,
      'crm_change_order',
      input.changeOrderId,
      newVersion,
      'updated'
    )
    return { ok: true, changeOrder: mapChangeOrder(updated) }
  })
}

/**
 * Reads the effective scope: base items + the deltas of APPROVED change orders only. This is the
 * concrete expression of "계약 범위와 변경 범위를 구분" — base and change scope come from separate
 * tables, and an unapproved change order's items never appear here.
 */
export async function getEffectiveScope(
  db: Kysely<Database>,
  organizationId: string,
  contractId: string
): Promise<EffectiveScope | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const contractRow = await trx
      .selectFrom('crm.contracts')
      .selectAll()
      .where('id', '=', contractId)
      .executeTakeFirst()
    if (!contractRow) {
      return null
    }
    const contract = mapContract(contractRow)
    const baseRows = await trx
      .selectFrom('crm.contract_scope_items')
      .selectAll()
      .where('contract_id', '=', contractId)
      .orderBy('sort_key', 'asc')
      .orderBy('id', 'asc')
      .execute()
    const baseItems = baseRows.map(mapScopeItem)
    const approvedOrders = await trx
      .selectFrom('crm.change_orders')
      .select('id')
      .where('contract_id', '=', contractId)
      .where('approval_status', '=', 'approved')
      .orderBy('approved_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    const appliedChangeOrders: EffectiveScope['appliedChangeOrders'] = []
    const effectiveItems: EffectiveScope['effectiveItems'] = baseItems.map((item) => ({
      ...item,
      source: 'base' as const
    }))
    for (const order of approvedOrders) {
      const itemRows = await trx
        .selectFrom('crm.change_order_scope_items')
        .selectAll()
        .where('change_order_id', '=', order.id)
        .orderBy('sort_key', 'asc')
        .orderBy('id', 'asc')
        .execute()
      const items = itemRows.map((row) => ({
        ...mapScopeItem(row),
        changeKind: row.change_kind as ScopeChangeKind
      }))
      appliedChangeOrders.push({ changeOrderId: order.id, items })
      for (const item of items) {
        effectiveItems.push({ ...item, source: 'change_order', changeOrderId: order.id })
      }
    }
    return { contract, baseItems, appliedChangeOrders, effectiveItems }
  })
}

export type CreateProjectFromContractResult =
  | { ok: true; projectId: string; linkId: string; createdAt: string }
  | { ok: false; reason: 'not_found' }
  // The exit condition: execution is refused before approval.
  | { ok: false; reason: 'not_approved'; approvalStatus: ContractApprovalStatus }

/**
 * The EXECUTION GATE. A project (delivery.projects) may only be created against an APPROVED (or
 * approved-then-'changed') contract — the assertContractExecutable check refuses a non-approved
 * contract with 'not_approved' (the route maps it to 422 CONTRACT_NOT_APPROVED). On success it
 * creates a delivery.projects row and records the OPAQUE link (crm.contract_projects.project_id
 * is a plain id into delivery — deliberately no cross-schema FK). One tenant tx; audited.
 */
export async function createProjectFromContract(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    contractId: string
    projectName: string
    projectSummary?: string | null
    activate?: boolean
  }
): Promise<CreateProjectFromContractResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const contractRow = await trx
      .selectFrom('crm.contracts')
      .selectAll()
      .where('id', '=', input.contractId)
      .forUpdate()
      .executeTakeFirst()
    if (!contractRow) {
      return { ok: false, reason: 'not_found' }
    }
    const status = contractRow.approval_status as ContractApprovalStatus
    if (!isContractExecutable(status)) {
      // No execution before approval — the exit-condition guard.
      await audit(
        trx,
        input.organizationId,
        input.actorUserId,
        'crm.contract.execution_refused',
        'crm_contract',
        input.contractId
      )
      return { ok: false, reason: 'not_approved', approvalStatus: status }
    }
    // Opaque cross-schema link: create the delivery.projects row directly in this tenant tx
    // (RLS/grants apply via withTenantTransaction) and store its id — no FK back into delivery.
    const project = await trx
      .insertInto('delivery.projects')
      .values({
        organization_id: input.organizationId,
        name: input.projectName,
        summary: input.projectSummary ?? null,
        status: input.activate ? 'active' : 'planned'
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow()
    const link = await trx
      .insertInto('crm.contract_projects')
      .values({
        organization_id: input.organizationId,
        contract_id: input.contractId,
        project_id: project.id,
        created_by: input.actorUserId
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'crm.contract.project_created',
      'crm_contract',
      input.contractId
    )
    await emitCrmChange(
      trx,
      input.organizationId,
      'crm_contract',
      input.contractId,
      Number(contractRow.version),
      'updated'
    )
    // Mirror project-store's project.created invalidation so the new project shows up live.
    await emitCrmChange(
      trx,
      input.organizationId,
      'project',
      project.id,
      Number(project.version),
      'created'
    )
    return {
      ok: true,
      projectId: project.id,
      linkId: link.id,
      createdAt: new Date(link.created_at).toISOString()
    }
  })
}

export async function listContractProjects(
  db: Kysely<Database>,
  organizationId: string,
  contractId: string
): Promise<{ id: string; projectId: string; createdAt: string }[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('crm.contract_projects')
      .select(['id', 'project_id', 'created_at'])
      .where('contract_id', '=', contractId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      createdAt: new Date(row.created_at).toISOString()
    }))
  })
}
