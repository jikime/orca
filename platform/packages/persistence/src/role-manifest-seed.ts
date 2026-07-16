import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { loadRoleManifestCatalog, type RoleManifestCatalog } from './role-manifest-catalog'
import { withoutTenantContext } from './tenant-transaction'

export type RoleSeedResult = {
  outcome: 'seeded' | 'unchanged'
  checksum: string
}

/**
 * Materializes the role/permission vocabulary from the manifests into the identity
 * tables so a fresh (or restored) DB is self-contained, and records the manifest
 * checksum so drift is detectable. Idempotent: if the recorded checksum already
 * matches the current manifest, it does nothing. Runs privileged (no tenant
 * context) — this is instance bootstrap, and the role tables are global.
 */
export async function seedRoleManifest(
  db: Kysely<Database>,
  catalog: RoleManifestCatalog = loadRoleManifestCatalog()
): Promise<RoleSeedResult> {
  return withoutTenantContext(db, async (trx) => {
    const existing = await trx
      .selectFrom('identity.role_manifest_seed')
      .select('checksum')
      .where('id', '=', true)
      .executeTakeFirst()
    if (existing?.checksum === catalog.checksum) {
      return { outcome: 'unchanged', checksum: catalog.checksum }
    }

    // Replace the vocabulary wholesale so a changed manifest converges exactly
    // (cascade clears role_permissions). Safe: these are global reference rows.
    await trx.deleteFrom('identity.role_permissions').execute()
    await trx.deleteFrom('identity.roles').execute()
    await trx.deleteFrom('identity.permissions').execute()

    await trx
      .insertInto('identity.permissions')
      .values(
        catalog.permissions.map((permission) => ({
          id: permission.id,
          resource: permission.resource,
          action: permission.action,
          risk: permission.risk
        }))
      )
      .execute()
    await trx
      .insertInto('identity.roles')
      .values(
        catalog.roles.map((role) => ({
          id: role.id,
          scope: role.scope,
          external: role.external
        }))
      )
      .execute()
    const rolePermissions = catalog.roles.flatMap((role) =>
      role.permissions.map((permissionId) => ({ role_id: role.id, permission_id: permissionId }))
    )
    if (rolePermissions.length > 0) {
      await trx.insertInto('identity.role_permissions').values(rolePermissions).execute()
    }

    await trx
      .insertInto('identity.role_manifest_seed')
      .values({ id: true, checksum: catalog.checksum })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ checksum: catalog.checksum, seeded_at: new Date() })
      )
      .execute()
    return { outcome: 'seeded', checksum: catalog.checksum }
  })
}
