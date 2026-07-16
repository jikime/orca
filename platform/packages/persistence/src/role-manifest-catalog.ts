import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// contracts/manifests is the SOURCE OF TRUTH for the role/permission vocabulary
// (roles.json defaultDeny + each role's permissions; permissions.json the catalog).
// App-layer roleId validation and permission resolution derive from here; the DB
// tables are a seeded, drift-detectable materialization (see role-manifest-seed).
const MANIFESTS_DIR = fileURLToPath(new URL('../../../../contracts/manifests', import.meta.url))

export type RoleDefinition = {
  id: string
  scope: string
  external: boolean
  permissions: string[]
}

export type PermissionDefinition = {
  id: string
  resource: string
  action: string
  risk: string
}

export type RoleManifestCatalog = {
  roles: RoleDefinition[]
  permissions: PermissionDefinition[]
  // Content hash of both manifests — recorded at seed time so drift is detectable.
  checksum: string
  hasRole: (roleId: string) => boolean
  // Union of permissions for the given role ids, unknown ids contributing nothing.
  permissionsForRoles: (roleIds: readonly string[]) => string[]
}

function readManifest(name: string): { raw: string; json: unknown } {
  const raw = readFileSync(`${MANIFESTS_DIR}/${name}`, 'utf-8')
  return { raw, json: JSON.parse(raw) as unknown }
}

let cached: RoleManifestCatalog | null = null

/** Loads and caches the role/permission catalog from the manifests. */
export function loadRoleManifestCatalog(): RoleManifestCatalog {
  if (cached) {
    return cached
  }
  const rolesDoc = readManifest('roles.json')
  const permissionsDoc = readManifest('permissions.json')
  const roles = (rolesDoc.json as { roles: RoleDefinition[] }).roles
  const permissions = (permissionsDoc.json as { permissions: PermissionDefinition[] }).permissions

  // Normalize before hashing so the checksum tracks meaning, not file formatting.
  const checksum = createHash('sha256').update(JSON.stringify({ roles, permissions })).digest('hex')

  const roleById = new Map(roles.map((role) => [role.id, role]))
  cached = {
    roles,
    permissions,
    checksum,
    hasRole: (roleId) => roleById.has(roleId),
    permissionsForRoles: (roleIds) => {
      const union = new Set<string>()
      for (const roleId of roleIds) {
        for (const permission of roleById.get(roleId)?.permissions ?? []) {
          union.add(permission)
        }
      }
      return [...union].sort()
    }
  }
  return cached
}
