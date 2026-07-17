import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeResourceType
} from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 2, the exit condition "요구사항이 작업, 코드, 테스트, 산출물, 검수까지 추적된다." This file owns
// the requirement entity and the two link/decision writes that make the chain: link to work items
// (trace DOWN) and record an acceptance (검수). The traceability READ lives in
// requirement-traceability-query.ts. contract_scope_item_id / project_id / work_item_id are OPAQUE
// cross-schema ids — no cross-schema FK, same-tenant integrity via the shared organization_id.

export type RequirementStatus =
  | 'draft'
  | 'approved'
  | 'implemented'
  | 'verified'
  | 'accepted'
  | 'rejected'

export type RequirementPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'
export type AcceptanceResult = 'pass' | 'fail' | 'conditional'

export type RequirementResource = {
  id: string
  organizationId: string
  projectId: string
  contractScopeItemId: string | null
  code: string
  title: string
  description: string | null
  status: RequirementStatus
  priority: RequirementPriority
  source: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type RequirementAcceptanceResource = {
  id: string
  organizationId: string
  requirementId: string
  result: AcceptanceResult
  acceptedBy: string
  acceptedAt: string
  notes: string | null
  deliverableRef: string | null
  revision: number
  createdAt: string
}

type RequirementRow = {
  id: string
  organization_id: string
  project_id: string
  contract_scope_item_id: string | null
  code: string
  title: string
  description: string | null
  status: string
  priority: string
  source: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapRequirement(row: RequirementRow): RequirementResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    contractScopeItemId: row.contract_scope_item_id,
    code: row.code,
    title: row.title,
    description: row.description,
    status: row.status as RequirementStatus,
    priority: row.priority as RequirementPriority,
    source: row.source,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

function mapAcceptance(row: {
  id: string
  organization_id: string
  requirement_id: string
  result: string
  accepted_by: string
  accepted_at: Date | string
  notes: string | null
  deliverable_ref: string | null
  revision: string | number
  created_at: Date | string
}): RequirementAcceptanceResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    requirementId: row.requirement_id,
    result: row.result as AcceptanceResult,
    acceptedBy: row.accepted_by,
    acceptedAt: new Date(row.accepted_at).toISOString(),
    notes: row.notes,
    deliverableRef: row.deliverable_ref,
    revision: Number(row.revision),
    createdAt: new Date(row.created_at).toISOString()
  }
}

async function emitRequirementChange(
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
  targetId: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorUserId,
      action,
      target_type: 'requirement',
      target_id: targetId
    })
    .execute()
}

export type CreateRequirementResult =
  | { ok: true; requirement: RequirementResource }
  | { ok: false; reason: 'duplicate_code' }

/**
 * Creates a requirement in status='draft' for a project, optionally tracing UP to a crm contract
 * scope line (opaque contract_scope_item_id — validated only for same-tenant existence, no FK). A
 * duplicate code within the project is rejected (unique per project).
 */
export async function createRequirement(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    projectId: string
    contractScopeItemId?: string | null
    code: string
    title: string
    description?: string | null
    priority?: RequirementPriority
    source?: string | null
  }
): Promise<CreateRequirementResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const existing = await trx
      .selectFrom('requirements.requirements')
      .select('id')
      .where('project_id', '=', input.projectId)
      .where('code', '=', input.code)
      .executeTakeFirst()
    if (existing) {
      return { ok: false, reason: 'duplicate_code' }
    }
    const row = await trx
      .insertInto('requirements.requirements')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        contract_scope_item_id: input.contractScopeItemId ?? null,
        code: input.code,
        title: input.title,
        description: input.description ?? null,
        status: 'draft',
        priority: input.priority ?? 'medium',
        source: input.source ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(trx, input.organizationId, input.actorUserId, 'requirement.created', row.id)
    await emitRequirementChange(trx, input.organizationId, 'requirement', row.id, 1, 'created')
    return { ok: true, requirement: mapRequirement(row) }
  })
}

export async function getRequirement(
  db: Kysely<Database>,
  organizationId: string,
  requirementId: string
): Promise<RequirementResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('requirements.requirements')
      .selectAll()
      .where('id', '=', requirementId)
      .executeTakeFirst()
    return row ? mapRequirement(row) : null
  })
}

export type RequirementTransitionResult =
  | { ok: true; requirement: RequirementResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: RequirementStatus }

// The lifecycle edges reachable via :transition (requirement.manage): a requirement is progressed
// draft → approved → implemented → verified as work lands. accepted/rejected are terminal and are
// reached ONLY through :accept / :reject (requirement.accept), never here.
const LEGAL_TRANSITIONS: Record<string, RequirementStatus> = {
  approve: 'draft',
  implement: 'approved',
  verify: 'implemented'
}
const TRANSITION_TARGET: Record<string, RequirementStatus> = {
  approve: 'approved',
  implement: 'implemented',
  verify: 'verified'
}

/**
 * Advances a requirement's lifecycle status under OCC (If-Match). Only the forward edges above are
 * legal; a stale expectedVersion → version_conflict, an out-of-order action → illegal_transition.
 */
export async function transitionRequirement(
  db: Kysely<Database>,
  input: {
    organizationId: string
    requirementId: string
    actorUserId: string
    action: 'approve' | 'implement' | 'verify'
    expectedVersion: number
  }
): Promise<RequirementTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('requirements.requirements')
      .selectAll()
      .where('id', '=', input.requirementId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as RequirementStatus
    if (from !== LEGAL_TRANSITIONS[input.action]) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('requirements.requirements')
      .set({
        status: TRANSITION_TARGET[input.action] ?? 'draft',
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.requirementId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `requirement.${input.action}`,
      input.requirementId
    )
    await emitRequirementChange(
      trx,
      input.organizationId,
      'requirement',
      input.requirementId,
      newVersion,
      'updated'
    )
    return { ok: true, requirement: mapRequirement(updated) }
  })
}

export type LinkWorkItemResult =
  | { ok: true; linkId: string; workItemId: string }
  | { ok: false; reason: 'requirement_not_found' }
  | { ok: false; reason: 'work_item_not_found' }

/**
 * Links a requirement to a work item that implements it (trace DOWN). work_item_id is an opaque id
 * into delivery.work_items — checked for same-tenant existence (the same-org integrity that stands
 * in for the absent cross-schema FK) but NOT foreign-keyed. Idempotent on (requirement, work_item):
 * a re-link returns the existing link id.
 */
export async function linkRequirementWorkItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    requirementId: string
    workItemId: string
  }
): Promise<LinkWorkItemResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const requirement = await trx
      .selectFrom('requirements.requirements')
      .select('id')
      .where('id', '=', input.requirementId)
      .executeTakeFirst()
    if (!requirement) {
      return { ok: false, reason: 'requirement_not_found' }
    }
    const workItem = await trx
      .selectFrom('delivery.work_items')
      .select('id')
      .where('id', '=', input.workItemId)
      .executeTakeFirst()
    if (!workItem) {
      return { ok: false, reason: 'work_item_not_found' }
    }
    const inserted = await trx
      .insertInto('requirements.requirement_work_items')
      .values({
        organization_id: input.organizationId,
        requirement_id: input.requirementId,
        work_item_id: input.workItemId,
        created_by: input.actorUserId
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'requirement_id', 'work_item_id']).doNothing()
      )
      .returning('id')
      .executeTakeFirst()
    let linkId = inserted?.id
    if (!linkId) {
      const existing = await trx
        .selectFrom('requirements.requirement_work_items')
        .select('id')
        .where('requirement_id', '=', input.requirementId)
        .where('work_item_id', '=', input.workItemId)
        .executeTakeFirstOrThrow()
      linkId = existing.id
    }
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'requirement.work_item_linked',
      input.requirementId
    )
    return { ok: true, linkId, workItemId: input.workItemId }
  })
}

export type UnlinkWorkItemResult =
  | { ok: true }
  | { ok: false; reason: 'requirement_not_found' | 'link_not_found' }

export async function unlinkRequirementWorkItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    requirementId: string
    workItemId: string
  }
): Promise<UnlinkWorkItemResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const requirement = await trx
      .selectFrom('requirements.requirements')
      .select('id')
      .where('id', '=', input.requirementId)
      .executeTakeFirst()
    if (!requirement) {
      return { ok: false, reason: 'requirement_not_found' }
    }
    const deleted = await trx
      .deleteFrom('requirements.requirement_work_items')
      .where('requirement_id', '=', input.requirementId)
      .where('work_item_id', '=', input.workItemId)
      .returning('id')
      .executeTakeFirst()
    if (!deleted) {
      return { ok: false, reason: 'link_not_found' }
    }
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'requirement.work_item_unlinked',
      input.requirementId
    )
    return { ok: true }
  })
}

export type RecordAcceptanceResult =
  | { ok: true; requirement: RequirementResource; acceptance: RequirementAcceptanceResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: RequirementStatus }

// :accept — a positive 검수 (result pass|conditional) moves the requirement to 'accepted'; it is only
// legal once the requirement has reached 'verified'. :reject — a fail moves it to 'rejected' from any
// non-terminal status. Both write an APPEND-ONLY acceptance row (evidence of the decision) in the
// same OCC-guarded, audited tx. accepted/rejected are terminal (not already-decided).
export async function recordRequirementAcceptance(
  db: Kysely<Database>,
  input: {
    organizationId: string
    requirementId: string
    actorUserId: string
    decision: 'accept' | 'reject'
    result?: AcceptanceResult
    notes?: string | null
    deliverableRef?: string | null
    expectedVersion: number
  }
): Promise<RecordAcceptanceResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('requirements.requirements')
      .selectAll()
      .where('id', '=', input.requirementId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as RequirementStatus
    if (from === 'accepted' || from === 'rejected') {
      return { ok: false, reason: 'illegal_transition', from }
    }
    // Acceptance (검수) presupposes a verified requirement; rejection may come from any live status.
    if (input.decision === 'accept' && from !== 'verified') {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const result: AcceptanceResult = input.decision === 'reject' ? 'fail' : (input.result ?? 'pass')
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('requirements.requirements')
      .set({
        status: input.decision === 'accept' ? 'accepted' : 'rejected',
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.requirementId)
      .returningAll()
      .executeTakeFirstOrThrow()
    const acceptance = await trx
      .insertInto('requirements.requirement_acceptances')
      .values({
        organization_id: input.organizationId,
        requirement_id: input.requirementId,
        result,
        accepted_by: input.actorUserId,
        notes: input.notes ?? null,
        deliverable_ref: input.deliverableRef ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `requirement.${input.decision}`,
      input.requirementId
    )
    await emitRequirementChange(
      trx,
      input.organizationId,
      'requirement',
      input.requirementId,
      newVersion,
      'updated'
    )
    await emitRequirementChange(
      trx,
      input.organizationId,
      'requirement_acceptance',
      acceptance.id,
      1,
      'created'
    )
    return { ok: true, requirement: mapRequirement(updated), acceptance: mapAcceptance(acceptance) }
  })
}

export async function listRequirementAcceptances(
  db: Kysely<Database>,
  organizationId: string,
  requirementId: string
): Promise<RequirementAcceptanceResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('requirements.requirement_acceptances')
      .selectAll()
      .where('requirement_id', '=', requirementId)
      .orderBy('accepted_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapAcceptance)
  })
}
