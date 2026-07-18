import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import { emitAssetResourceChange } from './asset-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R8 asset registry — the APPEND-ONLY lifecycle log. Every asset mutation writes exactly one event row
// via appendAssetEvent (inside the mutation's own tenant tx), so the asset history is a faithful audit
// trail. asset_id / actor_user_id are OPAQUE ids (no FK); detail is opaque structured context.

export type AssetEventKind =
  | 'created'
  | 'assigned'
  | 'unassigned'
  | 'status_changed'
  | 'moved'
  | 'linked'
  | 'unlinked'

export type AssetEventResource = {
  id: string
  organizationId: string
  assetId: string
  eventKind: AssetEventKind
  detail: unknown
  actorUserId: string | null
  occurredAt: string
}

type AssetEventRow = {
  id: string
  organization_id: string
  asset_id: string
  event_kind: string
  detail: unknown
  actor_user_id: string | null
  occurred_at: Date | string
}

export function mapAssetEvent(row: AssetEventRow): AssetEventResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    assetId: row.asset_id,
    eventKind: row.event_kind as AssetEventKind,
    detail: row.detail ?? null,
    actorUserId: row.actor_user_id,
    occurredAt: new Date(row.occurred_at).toISOString()
  }
}

/**
 * Appends one lifecycle event inside the caller's mutation tx (append-only: never updated in place),
 * and emits an asset_event resource change so the history feed invalidates live. Version is fixed at 1
 * because event rows are immutable.
 */
export async function appendAssetEvent(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    assetId: string
    actorUserId: string
    eventKind: AssetEventKind
    detail?: Record<string, unknown> | null
  }
): Promise<void> {
  const row = await trx
    .insertInto('assets.asset_events')
    .values({
      organization_id: input.organizationId,
      asset_id: input.assetId,
      event_kind: input.eventKind,
      detail: input.detail ? JSON.stringify(input.detail) : null,
      actor_user_id: input.actorUserId
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await emitAssetResourceChange(trx, input.organizationId, 'asset_event', row.id, 1, 'created')
}

export type AssetEventPage = { items: AssetEventResource[]; nextCursor: string | null }

/** Lists an asset's lifecycle events, newest first (occurred_at desc, id desc for a stable tiebreak). */
export async function listAssetEventsByAsset(
  db: Kysely<Database>,
  organizationId: string,
  assetId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<AssetEventPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('assets.asset_events')
      .selectAll()
      .where('asset_id', '=', assetId)
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '<', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapAssetEvent), nextCursor }
  })
}
