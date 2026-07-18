import { sql, type Kysely } from 'kysely'
import { auditAiEvent, emitAiResourceChange } from './ai-resource-events'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// ai.entitlements: what an org MAY use. The quota-consume path consults `allowed` (gate) and
// `quota_limit` (cap) for a resource; this store owns the admin upsert/list of those entitlements.

export type AiResourceKind = 'model' | 'tool'
export type AiQuotaPeriod = 'day' | 'month' | 'total'

export type AiEntitlementResource = {
  id: string
  organizationId: string
  resourceKind: AiResourceKind
  resourceKey: string
  allowed: boolean
  quotaLimit: number | null
  quotaPeriod: AiQuotaPeriod
  version: number
  createdAt: string
  updatedAt: string
}

type EntitlementRow = {
  id: string
  organization_id: string
  resource_kind: string
  resource_key: string
  allowed: boolean
  quota_limit: string | null
  quota_period: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapEntitlement(row: EntitlementRow): AiEntitlementResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    resourceKind: row.resource_kind as AiResourceKind,
    resourceKey: row.resource_key,
    allowed: row.allowed,
    quotaLimit: row.quota_limit === null ? null : Number(row.quota_limit),
    quotaPeriod: row.quota_period as AiQuotaPeriod,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type UpsertAiEntitlementInput = {
  organizationId: string
  actorUserId: string
  resourceKind: AiResourceKind
  resourceKey: string
  allowed: boolean
  quotaLimit?: number | null
  quotaPeriod?: AiQuotaPeriod
}

/**
 * Declaratively sets the org's entitlement for one resource (INSERT-or-UPDATE by the natural key
 * (org, resource_kind, resource_key)). On conflict it overwrites allowed/quota and bumps the OCC
 * version, so a repeated admin upsert converges without needing an If-Match.
 */
export async function upsertAiEntitlement(
  db: Kysely<Database>,
  input: UpsertAiEntitlementInput
): Promise<AiEntitlementResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('ai.entitlements')
      .values({
        organization_id: input.organizationId,
        resource_kind: input.resourceKind,
        resource_key: input.resourceKey,
        allowed: input.allowed,
        quota_limit: input.quotaLimit ?? null,
        quota_period: input.quotaPeriod ?? 'month'
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'resource_kind', 'resource_key']).doUpdateSet({
          allowed: input.allowed,
          quota_limit: input.quotaLimit ?? null,
          quota_period: input.quotaPeriod ?? 'month',
          version: sql`ai.entitlements.version + 1`,
          updated_at: sql`now()`
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAiEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'ai.entitlement.upserted',
      'ai_entitlement',
      row.id
    )
    await emitAiResourceChange(
      trx,
      input.organizationId,
      'ai_entitlement',
      row.id,
      Number(row.version),
      Number(row.version) === 1 ? 'created' : 'updated'
    )
    return mapEntitlement(row)
  })
}

export async function getAiEntitlement(
  db: Kysely<Database>,
  organizationId: string,
  entitlementId: string
): Promise<AiEntitlementResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('ai.entitlements')
      .selectAll()
      .where('id', '=', entitlementId)
      .executeTakeFirst()
    return row ? mapEntitlement(row) : null
  })
}

export type AiEntitlementPage = { items: AiEntitlementResource[]; nextCursor: string | null }

export async function listAiEntitlements(
  db: Kysely<Database>,
  organizationId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<AiEntitlementPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('ai.entitlements')
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
    return { items: page.map(mapEntitlement), nextCursor }
  })
}
