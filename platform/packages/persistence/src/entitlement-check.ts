import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { evaluateEntitlement, type EntitlementDecision } from './entitlement-evaluator'
import { withoutTenantContext } from './tenant-transaction'

const CORE_MEMBERS = 'core.members'
const CORE_PROJECTS = 'core.projects'

async function planGrantFor(
  trx: Transaction<Database>,
  organizationId: string,
  entitlementId: string
): Promise<{
  enforcement: 'limit' | 'boolean'
  limitValue: number | null
  booleanValue: boolean | null
} | null> {
  const subscription = await trx
    .selectFrom('identity.subscriptions')
    .select('plan_id')
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (!subscription) {
    // No subscription = the org is unmetered (billing assigns a plan; R4+).
    return null
  }
  const grant = await trx
    .selectFrom('identity.plan_entitlements')
    .select(['enforcement', 'limit_value', 'boolean_value'])
    .where('plan_id', '=', subscription.plan_id)
    .where('entitlement_id', '=', entitlementId)
    .executeTakeFirst()
  if (!grant) {
    return null
  }
  return {
    enforcement: grant.enforcement === 'boolean' ? 'boolean' : 'limit',
    limitValue: grant.limit_value === null ? null : Number(grant.limit_value),
    booleanValue: grant.boolean_value
  }
}

/**
 * Decides whether the org may add one active member (core.members). Enforced from a
 * LIVE count of active memberships (always accurate). An org with no subscription is
 * unmetered → allowed. Runs inside the caller's privileged transaction so the check
 * and the membership insert commit together (no TOCTOU gap).
 */
export async function memberEntitlementDecision(
  trx: Transaction<Database>,
  organizationId: string
): Promise<EntitlementDecision> {
  const grant = await planGrantFor(trx, organizationId, CORE_MEMBERS)
  if (!grant) {
    return { allowed: true, reason: 'allowed' }
  }
  const row = await trx
    .selectFrom('identity.memberships')
    .select(sql<string>`count(*)`.as('count'))
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'active')
    .executeTakeFirstOrThrow()
  return evaluateEntitlement({
    enforcement: grant.enforcement,
    grantValue: grant.enforcement === 'boolean' ? grant.booleanValue : grant.limitValue,
    currentUsage: Number(row.count),
    increment: 1
  })
}

/** DB-level convenience wrapper (privileged) for routes/tests. */
export async function checkMemberEntitlement(
  db: Kysely<Database>,
  organizationId: string
): Promise<EntitlementDecision> {
  return withoutTenantContext(db, (trx) => memberEntitlementDecision(trx, organizationId))
}

/**
 * Decides whether the org may add one project (core.projects) — same pattern as
 * members, from a live count of non-archived projects. Runs inside the caller's
 * transaction so the check and the project insert commit together.
 */
export async function projectEntitlementDecision(
  trx: Transaction<Database>,
  organizationId: string
): Promise<EntitlementDecision> {
  const grant = await planGrantFor(trx, organizationId, CORE_PROJECTS)
  if (!grant) {
    return { allowed: true, reason: 'allowed' }
  }
  const row = await trx
    .selectFrom('delivery.projects')
    .select(sql<string>`count(*)`.as('count'))
    .where('organization_id', '=', organizationId)
    .where('archived_at', 'is', null)
    .executeTakeFirstOrThrow()
  return evaluateEntitlement({
    enforcement: grant.enforcement,
    grantValue: grant.enforcement === 'boolean' ? grant.booleanValue : grant.limitValue,
    currentUsage: Number(row.count),
    increment: 1
  })
}
