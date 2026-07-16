import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withoutTenantContext } from './tenant-transaction'

export type OrganizationSeedInput = {
  id: string
  slug: string
  displayName: string
  version?: number
  status?: 'active' | 'suspended' | 'archived'
}

// Dev/test fixture aligned with contracts/fixtures/valid/organization.json.
export const DEFAULT_ORGANIZATION_FIXTURE: OrganizationSeedInput = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'kaon-soft-lab',
  displayName: 'Kaon Soft Lab',
  version: 1,
  status: 'active'
}

export type OrganizationSeedResult = {
  id: string
  inserted: boolean
}

/**
 * Idempotently seeds a temp organization fixture. Runs without tenant context
 * (organizations is the tenant root — it cannot be created inside a tenant) and
 * is a dev/test fixture loader, not a public endpoint. Re-running is a no-op.
 */
export async function seedOrganizationFixture(
  db: Kysely<Database>,
  input: OrganizationSeedInput = DEFAULT_ORGANIZATION_FIXTURE
): Promise<OrganizationSeedResult> {
  return withoutTenantContext(db, async (trx) => {
    const result = await trx
      .insertInto('identity.organizations')
      .values({
        id: input.id,
        slug: input.slug,
        display_name: input.displayName,
        status: input.status ?? 'active',
        version: input.version ?? 1
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirst()
    return { id: input.id, inserted: (result?.numInsertedOrUpdatedRows ?? 0n) > 0n }
  })
}
