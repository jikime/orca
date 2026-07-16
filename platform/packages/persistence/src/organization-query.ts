import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { loadRoleManifestCatalog, type RoleManifestCatalog } from './role-manifest-catalog'
import { withoutTenantContext, withTenantTransaction } from './tenant-transaction'
import { findUserAccountBySubject } from './user-account-query'
import type { AuthorizationPrincipal } from './authorize-request'

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

/**
 * The organizations the verified subject may see: those where they hold an active
 * membership whose role grants organization.read. Replaces the header stand-in —
 * the caller can only ever list orgs they actually belong to.
 */
export async function listOrganizationsForSubject(
  db: Kysely<Database>,
  principal: AuthorizationPrincipal,
  catalog: RoleManifestCatalog = loadRoleManifestCatalog()
): Promise<OrganizationResource[]> {
  return withoutTenantContext(db, async (trx) => {
    const account = await findUserAccountBySubject(trx, principal.issuer, principal.subject)
    if (!account) {
      return []
    }
    const memberships = await trx
      .selectFrom('identity.memberships')
      .select(['organization_id', 'role_ids'])
      .where('user_id', '=', account.id)
      .where('status', '=', 'active')
      .execute()
    const visibleOrgIds = memberships
      .filter((membership) =>
        catalog.permissionsForRoles(membership.role_ids).includes('organization.read')
      )
      .map((membership) => membership.organization_id)
    if (visibleOrgIds.length === 0) {
      return []
    }
    const rows = await trx
      .selectFrom('identity.organizations')
      .selectAll()
      .where('id', 'in', visibleOrgIds)
      .execute()
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
