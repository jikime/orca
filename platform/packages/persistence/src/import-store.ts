import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import type { ImportSource, NormalizedImportItem } from './import-normalized-item'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeResourceType
} from './resource-change-event'
import { createWorkItemTx } from './work-item-store'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 6: external import onto EXISTING delivery tables with dry-run + idempotent re-import. The
// external identity (external_system, external_key, resource_type) is the dedup key: a second import
// of the same key finds its imports.import_external_links row and UPDATEs the linked resource rather
// than inserting a second — so re-running an import never duplicates projects/users/work items.

const VALID_PROJECT_STATUS = new Set(['planned', 'active', 'paused', 'completed', 'cancelled'])

export type ImportPlanAction = 'create' | 'update' | 'skip'

export type ImportPlanItem = {
  externalSystem: string
  externalKey: string
  kind: 'project' | 'work_item'
  action: ImportPlanAction
  resourceId: string | null
  reason: string | null
}

export type ImportPlan = {
  items: ImportPlanItem[]
  totals: { created: number; updated: number; skipped: number }
}

export type ImportRunResource = {
  id: string
  organizationId: string
  source: ImportSource
  dryRun: boolean
  status: 'planned' | 'applied' | 'failed'
  createdCount: number
  updatedCount: number
  skippedCount: number
  actorUserId: string | null
  createdAt: string
}

export type RunImportResult = { run: ImportRunResource; plan: ImportPlan }

export type RunImportInput = {
  organizationId: string
  actorUserId: string
  source: ImportSource
  dryRun: boolean
  defaultTeamId?: string | null
  items: NormalizedImportItem[]
}

type ExistingLink = { id: string; resourceId: string }

async function emitImportChange(
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

async function auditImport(
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

/** Looks up the dedup link for an external identity within the tenant tx. */
async function findExternalLink(
  trx: Transaction<Database>,
  externalSystem: string,
  externalKey: string,
  resourceType: string
): Promise<ExistingLink | null> {
  const row = await trx
    .selectFrom('imports.import_external_links')
    .select(['id', 'resource_id'])
    .where('external_system', '=', externalSystem)
    .where('external_key', '=', externalKey)
    .where('resource_type', '=', resourceType)
    .executeTakeFirst()
  return row ? { id: row.id, resourceId: row.resource_id } : null
}

async function upsertExternalLink(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    existing: ExistingLink | null
    externalSystem: string
    externalKey: string
    resourceType: string
    resourceId: string
    importRunId: string
  }
): Promise<void> {
  if (input.existing) {
    // Re-point the existing mapping at the same run; the resource_id is unchanged (idempotent).
    await trx
      .updateTable('imports.import_external_links')
      .set({ import_run_id: input.importRunId, updated_at: sql`now()` })
      .where('id', '=', input.existing.id)
      .execute()
    return
  }
  await trx
    .insertInto('imports.import_external_links')
    .values({
      organization_id: input.organizationId,
      external_system: input.externalSystem,
      external_key: input.externalKey,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      import_run_id: input.importRunId
    })
    .execute()
}

/** Maps an external assignee to an EXISTING org user by email; null if none (users are never created). */
async function resolveAssigneeId(
  trx: Transaction<Database>,
  organizationId: string,
  email: string | null | undefined
): Promise<string | null> {
  if (!email) return null
  const row = await trx
    .selectFrom('identity.memberships')
    .innerJoin(
      'identity.user_accounts',
      'identity.user_accounts.id',
      'identity.memberships.user_id'
    )
    .select('identity.user_accounts.id as id')
    .where('identity.memberships.organization_id', '=', organizationId)
    .where(sql`lower(identity.user_accounts.email)`, '=', email.trim().toLowerCase())
    .executeTakeFirst()
  return row?.id ?? null
}

type ItemContext = {
  organizationId: string
  actorUserId: string
  importRunId: string
  defaultTeamId: string | null
}

async function applyProjectItem(
  trx: Transaction<Database>,
  ctx: ItemContext,
  item: NormalizedImportItem,
  existing: ExistingLink | null
): Promise<ImportPlanItem> {
  const status = item.status && VALID_PROJECT_STATUS.has(item.status) ? item.status : 'planned'
  if (existing) {
    const updated = await trx
      .updateTable('delivery.projects')
      .set({
        name: item.title,
        summary: item.summary ?? null,
        version: sql`version + 1`,
        updated_at: sql`now()`
      })
      .where('id', '=', existing.resourceId)
      .returning(['id', 'version'])
      .executeTakeFirst()
    // The link may outlive a deleted delivery row (opaque link, no FK) — treat as a skip if gone.
    if (!updated) {
      return skip(item, 'linked_project_missing')
    }
    await auditImport(
      trx,
      ctx.organizationId,
      ctx.actorUserId,
      'import.project.updated',
      'project',
      updated.id
    )
    await emitImportChange(
      trx,
      ctx.organizationId,
      'project',
      updated.id,
      Number(updated.version),
      'updated'
    )
    await upsertExternalLink(trx, linkArgs(ctx, item, 'project', updated.id, existing))
    return { ...base(item), action: 'update', resourceId: updated.id, reason: null }
  }
  const created = await trx
    .insertInto('delivery.projects')
    .values({
      organization_id: ctx.organizationId,
      name: item.title,
      summary: item.summary ?? null,
      status
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  await auditImport(
    trx,
    ctx.organizationId,
    ctx.actorUserId,
    'import.project.created',
    'project',
    created.id
  )
  await emitImportChange(trx, ctx.organizationId, 'project', created.id, 1, 'created')
  await upsertExternalLink(trx, linkArgs(ctx, item, 'project', created.id, null))
  return { ...base(item), action: 'create', resourceId: created.id, reason: null }
}

async function applyWorkItemItem(
  trx: Transaction<Database>,
  ctx: ItemContext,
  item: NormalizedImportItem,
  existing: ExistingLink | null
): Promise<ImportPlanItem> {
  if (existing) {
    const updated = await trx
      .updateTable('delivery.work_items')
      .set({
        title: item.title,
        description: item.description ?? null,
        version: sql`version + 1`,
        updated_at: sql`now()`
      })
      .where('id', '=', existing.resourceId)
      .returning(['id', 'version'])
      .executeTakeFirst()
    if (!updated) {
      return skip(item, 'linked_work_item_missing')
    }
    await auditImport(
      trx,
      ctx.organizationId,
      ctx.actorUserId,
      'import.work_item.updated',
      'work_item',
      updated.id
    )
    await emitImportChange(
      trx,
      ctx.organizationId,
      'work_item',
      updated.id,
      Number(updated.version),
      'updated'
    )
    await upsertExternalLink(trx, linkArgs(ctx, item, 'work_item', updated.id, existing))
    return { ...base(item), action: 'update', resourceId: updated.id, reason: null }
  }
  const teamId = item.teamId ?? ctx.defaultTeamId
  if (!teamId) {
    return skip(item, 'missing_team')
  }
  const assigneeId = await resolveAssigneeId(trx, ctx.organizationId, item.assigneeEmail)
  const result = await createWorkItemTx(trx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.actorUserId,
    teamId,
    title: item.title,
    description: item.description ?? null,
    assigneeId
  })
  if (!result.ok) {
    // A bad target (unknown team / no default state) skips this one item, never the whole import.
    return skip(item, result.reason)
  }
  await upsertExternalLink(trx, linkArgs(ctx, item, 'work_item', result.workItem.id, null))
  return { ...base(item), action: 'create', resourceId: result.workItem.id, reason: null }
}

function base(item: NormalizedImportItem): {
  externalSystem: string
  externalKey: string
  kind: 'project' | 'work_item'
} {
  return { externalSystem: item.externalSystem, externalKey: item.externalKey, kind: item.kind }
}

function skip(item: NormalizedImportItem, reason: string): ImportPlanItem {
  return { ...base(item), action: 'skip', resourceId: null, reason }
}

function linkArgs(
  ctx: ItemContext,
  item: NormalizedImportItem,
  resourceType: string,
  resourceId: string,
  existing: ExistingLink | null
): Parameters<typeof upsertExternalLink>[1] {
  return {
    organizationId: ctx.organizationId,
    existing,
    externalSystem: item.externalSystem,
    externalKey: item.externalKey,
    resourceType,
    resourceId,
    importRunId: ctx.importRunId
  }
}

function tallyPlan(items: ImportPlanItem[]): ImportPlan['totals'] {
  const totals = { created: 0, updated: 0, skipped: 0 }
  for (const item of items) {
    if (item.action === 'create') totals.created += 1
    else if (item.action === 'update') totals.updated += 1
    else totals.skipped += 1
  }
  return totals
}

function mapRun(row: {
  id: string
  organization_id: string
  source: string
  dry_run: boolean
  status: string
  created_count: number | string
  updated_count: number | string
  skipped_count: number | string
  actor_user_id: string | null
  created_at: Date | string
}): ImportRunResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    source: row.source as ImportSource,
    dryRun: row.dry_run,
    status: row.status as ImportRunResource['status'],
    createdCount: Number(row.created_count),
    updatedCount: Number(row.updated_count),
    skippedCount: Number(row.skipped_count),
    actorUserId: row.actor_user_id,
    createdAt: new Date(row.created_at).toISOString()
  }
}

/**
 * Executes (or, for dryRun, only plans) an import in ONE tenant transaction. dryRun=true reads the
 * dedup links to compute each item's create/update action but writes NO delivery resource and NO
 * external link — it persists only a status='planned' import_runs audit row. dryRun=false upserts
 * projects/work_items, upserts the external links, and writes a status='applied' run with counts.
 */
export async function runImport(
  db: Kysely<Database>,
  input: RunImportInput
): Promise<RunImportResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const runId = randomUUID()
    // The run row is written first so external_links can FK it in the same tx.
    const runStatus = input.dryRun ? 'planned' : 'applied'
    await trx
      .insertInto('imports.import_runs')
      .values({
        id: runId,
        organization_id: input.organizationId,
        source: input.source,
        dry_run: input.dryRun,
        status: runStatus,
        actor_user_id: input.actorUserId
      })
      .execute()

    const ctx: ItemContext = {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      importRunId: runId,
      defaultTeamId: input.defaultTeamId ?? null
    }
    const planItems: ImportPlanItem[] = []
    for (const item of input.items) {
      const existing = await findExternalLink(trx, item.externalSystem, item.externalKey, item.kind)
      if (input.dryRun) {
        // dry-run writes nothing: report create when unlinked, update when already linked.
        planItems.push({
          ...base(item),
          action: existing ? 'update' : 'create',
          resourceId: existing?.resourceId ?? null,
          reason: null
        })
        continue
      }
      planItems.push(
        item.kind === 'project'
          ? await applyProjectItem(trx, ctx, item, existing)
          : await applyWorkItemItem(trx, ctx, item, existing)
      )
    }

    const totals = tallyPlan(planItems)
    const finalRun = await trx
      .updateTable('imports.import_runs')
      .set({
        created_count: totals.created,
        updated_count: totals.updated,
        skipped_count: totals.skipped
      })
      .where('id', '=', runId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditImport(
      trx,
      input.organizationId,
      input.actorUserId,
      `import.run.${runStatus}`,
      'import_run',
      runId
    )
    if (!input.dryRun) {
      await emitImportChange(trx, input.organizationId, 'import_run', runId, 1, 'created')
    }
    return { run: mapRun(finalRun), plan: { items: planItems, totals } }
  })
}

export async function getImportRun(
  db: Kysely<Database>,
  organizationId: string,
  runId: string
): Promise<ImportRunResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('imports.import_runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst()
    return row ? mapRun(row) : null
  })
}
