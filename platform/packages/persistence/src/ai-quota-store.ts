import { sql, type Kysely } from 'kysely'
import type { AiResourceKind } from './ai-entitlement-store'
import { auditAiEvent } from './ai-resource-events'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// ai.quota_usage: the ENFORCEMENT core. consumeQuota is the single mutation that (a) checks the org
// holds an `allowed` entitlement for the resource and (b) increments the period counter only within
// the entitlement's quota_limit. quota_usage is enforcement state, not a realtime resource, so no
// outbox event is emitted here.

export type AiQuotaUsageResource = {
  organizationId: string
  resourceKind: AiResourceKind
  resourceKey: string
  periodKey: string
  used: number
  quotaLimit: number | null
}

export type ConsumeQuotaInput = {
  organizationId: string
  actorUserId: string
  resourceKind: AiResourceKind
  resourceKey: string
  periodKey: string
  amount: number
}

export type ConsumeQuotaResult =
  | { ok: true; usage: AiQuotaUsageResource; usageId: string }
  | { ok: false; reason: 'invalid_amount' }
  | { ok: false; reason: 'not_entitled' }
  | { ok: false; reason: 'quota_exceeded'; used: number; limit: number; requested: number }

/**
 * Atomically consumes `amount` of a resource's quota. Refuses (no increment) when the org is not
 * entitled, or when a quota_limit is set and used+amount would exceed it. Atomicity: the usage row is
 * upserted-then-locked FOR UPDATE inside the tenant tx, so concurrent consumes serialize on the lock
 * and cannot overspend a limited quota.
 */
export async function consumeQuota(
  db: Kysely<Database>,
  input: ConsumeQuotaInput
): Promise<ConsumeQuotaResult> {
  if (!(input.amount > 0)) {
    return { ok: false, reason: 'invalid_amount' }
  }
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const entitlement = await trx
      .selectFrom('ai.entitlements')
      .select(['allowed', 'quota_limit'])
      .where('resource_kind', '=', input.resourceKind)
      .where('resource_key', '=', input.resourceKey)
      .executeTakeFirst()
    // Not entitled → refuse before any counter mutation.
    if (!entitlement || !entitlement.allowed) {
      return { ok: false, reason: 'not_entitled' }
    }
    const limit = entitlement.quota_limit === null ? null : Number(entitlement.quota_limit)

    // Ensure the period counter row exists, then lock it so the read-check-increment is atomic.
    await trx
      .insertInto('ai.quota_usage')
      .values({
        organization_id: input.organizationId,
        resource_kind: input.resourceKind,
        resource_key: input.resourceKey,
        period_key: input.periodKey,
        used: 0
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'resource_kind', 'resource_key', 'period_key']).doNothing()
      )
      .execute()
    const current = await trx
      .selectFrom('ai.quota_usage')
      .select(['id', 'used'])
      .where('resource_kind', '=', input.resourceKind)
      .where('resource_key', '=', input.resourceKey)
      .where('period_key', '=', input.periodKey)
      .forUpdate()
      .executeTakeFirstOrThrow()
    const used = Number(current.used)
    const next = used + input.amount
    // Limit set and would be exceeded → refuse with NO increment.
    if (limit !== null && next > limit) {
      return { ok: false, reason: 'quota_exceeded', used, limit, requested: input.amount }
    }
    const updated = await trx
      .updateTable('ai.quota_usage')
      .set({ used: next, version: sql`ai.quota_usage.version + 1`, updated_at: sql`now()` })
      .where('id', '=', current.id)
      .returning(['id', 'used'])
      .executeTakeFirstOrThrow()
    await auditAiEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'ai.quota.consumed',
      'ai_quota_usage',
      updated.id
    )
    return {
      ok: true,
      usageId: updated.id,
      usage: {
        organizationId: input.organizationId,
        resourceKind: input.resourceKind,
        resourceKey: input.resourceKey,
        periodKey: input.periodKey,
        used: Number(updated.used),
        quotaLimit: limit
      }
    }
  })
}

export async function getQuotaUsageById(
  db: Kysely<Database>,
  organizationId: string,
  usageId: string
): Promise<AiQuotaUsageResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('ai.quota_usage')
      .selectAll()
      .where('id', '=', usageId)
      .executeTakeFirst()
    if (!row) {
      return null
    }
    const entitlement = await trx
      .selectFrom('ai.entitlements')
      .select(['quota_limit'])
      .where('resource_kind', '=', row.resource_kind)
      .where('resource_key', '=', row.resource_key)
      .executeTakeFirst()
    return {
      organizationId: row.organization_id,
      resourceKind: row.resource_kind as AiResourceKind,
      resourceKey: row.resource_key,
      periodKey: row.period_key,
      used: Number(row.used),
      quotaLimit:
        entitlement && entitlement.quota_limit !== null ? Number(entitlement.quota_limit) : null
    }
  })
}
