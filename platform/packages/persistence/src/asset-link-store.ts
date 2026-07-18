import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditAssetEvent, emitAssetResourceChange } from './asset-resource-events'
import { appendAssetEvent } from './asset-event-store'
import { withTenantTransaction } from './tenant-transaction'

// R8 asset registry — the CMDB relationship graph edge. asset_id / linked_id are OPAQUE ids (no FK) so
// an edge to a service ticket / work item / another asset never cascades. The DB UNIQUE key is the sole
// arbiter of duplicate edges (see createAssetLink: an insert that the constraint suppresses ⇒ duplicate).

export type LinkedKind = 'ticket' | 'work_item' | 'asset'
export type LinkRelation = 'used_by' | 'depends_on' | 'affected_by' | 'related'

export type AssetLinkResource = {
  id: string
  organizationId: string
  assetId: string
  linkedKind: LinkedKind
  linkedId: string
  relation: LinkRelation
  version: number
  createdAt: string
  updatedAt: string
}

type AssetLinkRow = {
  id: string
  organization_id: string
  asset_id: string
  linked_kind: string
  linked_id: string
  relation: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapAssetLink(row: AssetLinkRow): AssetLinkResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    assetId: row.asset_id,
    linkedKind: row.linked_kind as LinkedKind,
    linkedId: row.linked_id,
    relation: row.relation as LinkRelation,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateAssetLinkResult =
  | { ok: true; link: AssetLinkResource }
  | { ok: false; reason: 'duplicate' }

/** Adds a CMDB edge; a duplicate (organization_id, asset_id, linked_kind, linked_id, relation) is
 *  suppressed by the UNIQUE constraint and surfaces as reason='duplicate' (⇒ 409). */
export async function createAssetLink(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    assetId: string
    linkedKind: LinkedKind
    linkedId: string
    relation?: LinkRelation
  }
): Promise<CreateAssetLinkResult> {
  const relation = input.relation ?? 'related'
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const inserted = await trx
      .insertInto('assets.asset_links')
      .values({
        organization_id: input.organizationId,
        asset_id: input.assetId,
        linked_kind: input.linkedKind,
        linked_id: input.linkedId,
        relation
      })
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'asset_id', 'linked_kind', 'linked_id', 'relation'])
          .doNothing()
      )
      .returningAll()
      .executeTakeFirst()
    if (!inserted) {
      return { ok: false, reason: 'duplicate' }
    }
    await appendAssetEvent(trx, {
      organizationId: input.organizationId,
      assetId: input.assetId,
      actorUserId: input.actorUserId,
      eventKind: 'linked',
      detail: { linkedKind: input.linkedKind, linkedId: input.linkedId, relation }
    })
    await auditAssetEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'asset.linked',
      'asset_link',
      inserted.id
    )
    await emitAssetResourceChange(
      trx,
      input.organizationId,
      'asset_link',
      inserted.id,
      1,
      'created'
    )
    return { ok: true, link: mapAssetLink(inserted) }
  })
}

export type DeleteAssetLinkResult = { ok: true } | { ok: false; reason: 'not_found' }

/** Removes a CMDB edge and appends an 'unlinked' event to the asset history. */
export async function deleteAssetLink(
  db: Kysely<Database>,
  input: { organizationId: string; actorUserId: string; linkId: string }
): Promise<DeleteAssetLinkResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const existing = await trx
      .selectFrom('assets.asset_links')
      .selectAll()
      .where('id', '=', input.linkId)
      .executeTakeFirst()
    if (!existing) {
      return { ok: false, reason: 'not_found' }
    }
    await trx.deleteFrom('assets.asset_links').where('id', '=', input.linkId).execute()
    await appendAssetEvent(trx, {
      organizationId: input.organizationId,
      assetId: existing.asset_id,
      actorUserId: input.actorUserId,
      eventKind: 'unlinked',
      detail: { linkedKind: existing.linked_kind, linkedId: existing.linked_id }
    })
    await auditAssetEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'asset.unlinked',
      'asset_link',
      input.linkId
    )
    await emitAssetResourceChange(
      trx,
      input.organizationId,
      'asset_link',
      input.linkId,
      1,
      'deleted'
    )
    return { ok: true }
  })
}

export type AssetLinkPage = { items: AssetLinkResource[]; nextCursor: string | null }

/** Lists the CMDB edges of one asset. */
export async function listAssetLinksByAsset(
  db: Kysely<Database>,
  organizationId: string,
  assetId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<AssetLinkPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('assets.asset_links')
      .selectAll()
      .where('asset_id', '=', assetId)
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapAssetLink), nextCursor }
  })
}
