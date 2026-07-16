import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// Shape of contracts/schemas/resources/organization.v1.
export type OrganizationResource = {
  id: string
  displayName: string
  slug: string
  version: number
  createdAt: string
  updatedAt: string
}

/**
 * Lists the organizations visible to the tenant. Under RLS the pie_app role sees
 * only its own organization row, so this returns exactly that until R3 adds
 * multi-org membership via the authenticated subject.
 */
export async function listOrganizationsForTenant(
  db: Kysely<Database>,
  organizationId: string
): Promise<OrganizationResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx.selectFrom('identity.organizations').selectAll().execute()
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      slug: row.slug,
      version: Number(row.version),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    }))
  })
}
