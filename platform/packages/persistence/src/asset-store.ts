import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditAssetEvent, emitAssetResourceChange } from './asset-resource-events'
import { appendAssetEvent } from './asset-event-store'
import { withTenantTransaction } from './tenant-transaction'

// R8 asset registry — a registry entry with lifecycle + assignment. account_id / project_id /
// assigned_to_user_id are OPAQUE cross-schema ids — no FK, same-tenant integrity via organization_id.
// status walks active → in_repair → active|retired|lost (a status change is the OCC :transition;
// assignment is an OCC update). Every mutation appends exactly one asset_event (the history log).

export type AssetType = 'hardware' | 'software' | 'license' | 'service' | 'other'
export type AssetStatus = 'active' | 'in_repair' | 'retired' | 'lost'
export type AssetStatusAction = 'repair' | 'restore' | 'retire' | 'report_lost'

export type AssetResource = {
  id: string
  organizationId: string
  name: string
  assetType: AssetType
  status: AssetStatus
  accountId: string | null
  projectId: string | null
  assignedToUserId: string | null
  identifier: string | null
  vendor: string | null
  purchaseDate: string | null
  warrantyEnd: string | null
  notes: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type AssetRow = {
  id: string
  organization_id: string
  name: string
  asset_type: string
  status: string
  account_id: string | null
  project_id: string | null
  assigned_to_user_id: string | null
  identifier: string | null
  vendor: string | null
  purchase_date: string | null
  warranty_end: string | null
  notes: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapAsset(row: AssetRow): AssetResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    assetType: row.asset_type as AssetType,
    status: row.status as AssetStatus,
    accountId: row.account_id,
    projectId: row.project_id,
    assignedToUserId: row.assigned_to_user_id,
    identifier: row.identifier,
    vendor: row.vendor,
    purchaseDate: row.purchase_date,
    warrantyEnd: row.warranty_end,
    notes: row.notes,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateAssetInput = {
  organizationId: string
  actorUserId: string
  name: string
  assetType?: AssetType
  accountId?: string | null
  projectId?: string | null
  assignedToUserId?: string | null
  identifier?: string | null
  vendor?: string | null
  purchaseDate?: string | null
  warrantyEnd?: string | null
  notes?: string | null
}

/** Creates an asset in status='active' and appends the 'created' lifecycle event. */
export async function createAsset(
  db: Kysely<Database>,
  input: CreateAssetInput
): Promise<AssetResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('assets.assets')
      .values({
        organization_id: input.organizationId,
        name: input.name,
        asset_type: input.assetType ?? 'hardware',
        status: 'active',
        account_id: input.accountId ?? null,
        project_id: input.projectId ?? null,
        assigned_to_user_id: input.assignedToUserId ?? null,
        identifier: input.identifier ?? null,
        vendor: input.vendor ?? null,
        purchase_date: input.purchaseDate ?? null,
        warranty_end: input.warrantyEnd ?? null,
        notes: input.notes ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await appendAssetEvent(trx, {
      organizationId: input.organizationId,
      assetId: row.id,
      actorUserId: input.actorUserId,
      eventKind: 'created'
    })
    await auditAssetEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'asset.created',
      'asset',
      row.id
    )
    await emitAssetResourceChange(trx, input.organizationId, 'asset', row.id, 1, 'created')
    return mapAsset(row)
  })
}

export async function getAsset(
  db: Kysely<Database>,
  organizationId: string,
  assetId: string
): Promise<AssetResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('assets.assets')
      .selectAll()
      .where('id', '=', assetId)
      .executeTakeFirst()
    return row ? mapAsset(row) : null
  })
}

export type AssetPage = { items: AssetResource[]; nextCursor: string | null }

/** Lists assets, filterable by account, project, status, and assignee (the per-customer registry view). */
export async function listAssets(
  db: Kysely<Database>,
  organizationId: string,
  options: {
    accountId?: string
    projectId?: string
    status?: AssetStatus
    assignedToUserId?: string
    limit?: number
    cursor?: string | null
  } = {}
): Promise<AssetPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('assets.assets')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.accountId) {
      query = query.where('account_id', '=', options.accountId)
    }
    if (options.projectId) {
      query = query.where('project_id', '=', options.projectId)
    }
    if (options.status) {
      query = query.where('status', '=', options.status)
    }
    if (options.assignedToUserId) {
      query = query.where('assigned_to_user_id', '=', options.assignedToUserId)
    }
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapAsset), nextCursor }
  })
}

export type UpdateAssetResult =
  | { ok: true; asset: AssetResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export type UpdateAssetInput = {
  organizationId: string
  assetId: string
  actorUserId: string
  expectedVersion: number
  name?: string
  assetType?: AssetType
  accountId?: string | null
  projectId?: string | null
  identifier?: string | null
  vendor?: string | null
  purchaseDate?: string | null
  warrantyEnd?: string | null
  notes?: string | null
}

/** Edits asset metadata under OCC (If-Match). Status and assignment have their own dedicated verbs. */
export async function updateAsset(
  db: Kysely<Database>,
  input: UpdateAssetInput
): Promise<UpdateAssetResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('assets.assets')
      .selectAll()
      .where('id', '=', input.assetId)
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
      .updateTable('assets.assets')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.assetType === undefined ? {} : { asset_type: input.assetType }),
        ...(input.accountId === undefined ? {} : { account_id: input.accountId }),
        ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
        ...(input.identifier === undefined ? {} : { identifier: input.identifier }),
        ...(input.vendor === undefined ? {} : { vendor: input.vendor }),
        ...(input.purchaseDate === undefined ? {} : { purchase_date: input.purchaseDate }),
        ...(input.warrantyEnd === undefined ? {} : { warranty_end: input.warrantyEnd }),
        ...(input.notes === undefined ? {} : { notes: input.notes })
      })
      .where('id', '=', input.assetId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAssetEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'asset.updated',
      'asset',
      updated.id
    )
    await emitAssetResourceChange(
      trx,
      input.organizationId,
      'asset',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, asset: mapAsset(updated) }
  })
}

export type AssetTransitionResult =
  | { ok: true; asset: AssetResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: AssetStatus }

// Legal status edges: active → in_repair (repair); in_repair → active (restore);
// active|in_repair → retired (retire) | lost (report_lost). retired/lost are terminal.
const LEGAL_FROMS: Record<AssetStatusAction, AssetStatus[]> = {
  repair: ['active'],
  restore: ['in_repair'],
  retire: ['active', 'in_repair'],
  report_lost: ['active', 'in_repair']
}
const TO_STATUS: Record<AssetStatusAction, AssetStatus> = {
  repair: 'in_repair',
  restore: 'active',
  retire: 'retired',
  report_lost: 'lost'
}

/** Advances an asset's status under OCC (If-Match) and appends a 'status_changed' event. */
export async function transitionAssetStatus(
  db: Kysely<Database>,
  input: {
    organizationId: string
    assetId: string
    actorUserId: string
    action: AssetStatusAction
    expectedVersion: number
  }
): Promise<AssetTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('assets.assets')
      .selectAll()
      .where('id', '=', input.assetId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as AssetStatus
    if (!LEGAL_FROMS[input.action].includes(from)) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const to = TO_STATUS[input.action]
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('assets.assets')
      .set({ status: to, version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.assetId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await appendAssetEvent(trx, {
      organizationId: input.organizationId,
      assetId: input.assetId,
      actorUserId: input.actorUserId,
      eventKind: 'status_changed',
      detail: { from, to }
    })
    await auditAssetEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `asset.${input.action}`,
      'asset',
      input.assetId
    )
    await emitAssetResourceChange(
      trx,
      input.organizationId,
      'asset',
      input.assetId,
      newVersion,
      'updated'
    )
    return { ok: true, asset: mapAsset(updated) }
  })
}

/** Assigns (or, with null, unassigns) an asset under OCC (If-Match) and appends the matching event. */
export async function assignAsset(
  db: Kysely<Database>,
  input: {
    organizationId: string
    assetId: string
    actorUserId: string
    assignedToUserId: string | null
    expectedVersion: number
  }
): Promise<UpdateAssetResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('assets.assets')
      .selectAll()
      .where('id', '=', input.assetId)
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
      .updateTable('assets.assets')
      .set({
        assigned_to_user_id: input.assignedToUserId,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.assetId)
      .returningAll()
      .executeTakeFirstOrThrow()
    const assigning = input.assignedToUserId !== null
    await appendAssetEvent(trx, {
      organizationId: input.organizationId,
      assetId: input.assetId,
      actorUserId: input.actorUserId,
      eventKind: assigning ? 'assigned' : 'unassigned',
      detail: assigning ? { assignedToUserId: input.assignedToUserId } : null
    })
    await auditAssetEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      assigning ? 'asset.assigned' : 'asset.unassigned',
      'asset',
      input.assetId
    )
    await emitAssetResourceChange(
      trx,
      input.organizationId,
      'asset',
      input.assetId,
      newVersion,
      'updated'
    )
    return { ok: true, asset: mapAsset(updated) }
  })
}
