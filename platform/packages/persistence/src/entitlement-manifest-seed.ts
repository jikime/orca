import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import {
  loadEntitlementManifestCatalog,
  type EntitlementManifestCatalog
} from './entitlement-manifest-catalog'
import { withoutTenantContext } from './tenant-transaction'

export type EntitlementSeedResult = { outcome: 'seeded' | 'unchanged'; checksum: string }

/**
 * Materializes the plan catalog from the manifest into identity.entitlement_plans
 * + plan_entitlements with a checksum, so a fresh/restored DB is self-contained and
 * manifest drift is detectable. Idempotent (no-op when the checksum matches).
 */
export async function seedEntitlementManifest(
  db: Kysely<Database>,
  catalog: EntitlementManifestCatalog = loadEntitlementManifestCatalog()
): Promise<EntitlementSeedResult> {
  return withoutTenantContext(db, async (trx) => {
    const existing = await trx
      .selectFrom('identity.entitlement_manifest_seed')
      .select('checksum')
      .where('id', '=', true)
      .executeTakeFirst()
    if (existing?.checksum === catalog.checksum) {
      return { outcome: 'unchanged', checksum: catalog.checksum }
    }
    await trx.deleteFrom('identity.plan_entitlements').execute()
    await trx.deleteFrom('identity.entitlement_plans').execute()

    await trx
      .insertInto('identity.entitlement_plans')
      .values(catalog.plans.map((plan) => ({ id: plan.id })))
      .execute()
    const planEntitlements = catalog.plans.flatMap((plan) =>
      Object.entries(plan.grants).map(([entitlementId, grantValue]) => ({
        plan_id: plan.id,
        entitlement_id: entitlementId,
        enforcement: catalog.enforcementOf(entitlementId) ?? 'limit',
        limit_value: typeof grantValue === 'number' ? grantValue : null,
        boolean_value: typeof grantValue === 'boolean' ? grantValue : null
      }))
    )
    if (planEntitlements.length > 0) {
      await trx.insertInto('identity.plan_entitlements').values(planEntitlements).execute()
    }
    await trx
      .insertInto('identity.entitlement_manifest_seed')
      .values({ id: true, checksum: catalog.checksum })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ checksum: catalog.checksum, seeded_at: new Date() })
      )
      .execute()
    return { outcome: 'seeded', checksum: catalog.checksum }
  })
}
