import { sql, type Kysely } from 'kysely'
import { auditAutomationEvent, emitAutomationResourceChange } from './automation-resource-events'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// A runbook DEFINITION. requires_approval (default true) is the property the execution store consults
// when creating a run: an execution of an approval-required runbook starts inert (pending_approval).

export type RunbookTargetKind = 'project' | 'ticket' | 'environment'

export type RunbookResource = {
  id: string
  organizationId: string
  name: string
  description: string | null
  steps: unknown[]
  targetKind: RunbookTargetKind
  requiresApproval: boolean
  version: number
  createdAt: string
  updatedAt: string
}

type RunbookRow = {
  id: string
  organization_id: string
  name: string
  description: string | null
  steps: unknown
  target_kind: string
  requires_approval: boolean
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function toSteps(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function mapRunbook(row: RunbookRow): RunbookResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    steps: toSteps(row.steps),
    targetKind: row.target_kind as RunbookTargetKind,
    requiresApproval: row.requires_approval,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateRunbookInput = {
  organizationId: string
  actorUserId: string
  name: string
  description?: string | null
  steps?: unknown[]
  targetKind: RunbookTargetKind
  requiresApproval?: boolean
}

export async function createRunbook(
  db: Kysely<Database>,
  input: CreateRunbookInput
): Promise<RunbookResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('automation.runbooks')
      .values({
        organization_id: input.organizationId,
        name: input.name,
        description: input.description ?? null,
        steps: JSON.stringify(input.steps ?? []),
        target_kind: input.targetKind,
        requires_approval: input.requiresApproval ?? true
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAutomationEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'automation.runbook.created',
      'runbook',
      row.id
    )
    await emitAutomationResourceChange(trx, input.organizationId, 'runbook', row.id, 1, 'created')
    return mapRunbook(row)
  })
}

export async function getRunbook(
  db: Kysely<Database>,
  organizationId: string,
  runbookId: string
): Promise<RunbookResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('automation.runbooks')
      .selectAll()
      .where('id', '=', runbookId)
      .executeTakeFirst()
    return row ? mapRunbook(row) : null
  })
}

export type RunbookPage = { items: RunbookResource[]; nextCursor: string | null }

export async function listRunbooks(
  db: Kysely<Database>,
  organizationId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<RunbookPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('automation.runbooks')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapRunbook), nextCursor }
  })
}

export type UpdateRunbookResult =
  | { ok: true; runbook: RunbookResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export type UpdateRunbookInput = {
  organizationId: string
  runbookId: string
  actorUserId: string
  expectedVersion: number
  name?: string
  description?: string | null
  steps?: unknown[]
  targetKind?: RunbookTargetKind
  requiresApproval?: boolean
}

export async function updateRunbook(
  db: Kysely<Database>,
  input: UpdateRunbookInput
): Promise<UpdateRunbookResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('automation.runbooks')
      .selectAll()
      .where('id', '=', input.runbookId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('automation.runbooks')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.steps === undefined ? {} : { steps: JSON.stringify(input.steps) }),
        ...(input.targetKind === undefined ? {} : { target_kind: input.targetKind }),
        ...(input.requiresApproval === undefined
          ? {}
          : { requires_approval: input.requiresApproval })
      })
      .where('id', '=', input.runbookId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAutomationEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'automation.runbook.updated',
      'runbook',
      updated.id
    )
    await emitAutomationResourceChange(
      trx,
      input.organizationId,
      'runbook',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, runbook: mapRunbook(updated) }
  })
}
