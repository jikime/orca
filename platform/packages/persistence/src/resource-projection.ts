import type { Kysely } from 'kysely'
import type { CommentResource } from './comment-store'
import type { Database } from './database-schema'
import type { ProjectResource } from './project-store'
import { loadRoleManifestCatalog, type RoleManifestCatalog } from './role-manifest-catalog'
import { withoutTenantContext } from './tenant-transaction'
import { findUserAccountBySubject } from './user-account-query'
import type { WorkItemResource } from './work-item-store'

// TEN-004: an external (customer/partner) role must not see internal-only fields or
// internal comments (doc 24 TEN-004, doc 27:430). Field projection + a visibility
// filter enforce this. Full customer-org-on-project relations are Planning Gate; this
// slice proves the projection with a customer membership fixture at the org level.
export type Audience = 'internal' | 'external'

// Internal-only execution fields redacted from a work item for an external audience.
const INTERNAL_WORK_ITEM_FIELDS = ['assigneeId', 'priority', 'sortKey', 'workflowVersion'] as const
// Internal delivery fields redacted from a project for an external audience.
const INTERNAL_PROJECT_FIELDS = ['summary', 'status'] as const

/**
 * An audience is 'external' only when the membership has roles and ALL of them are
 * external — any internal role grants internal visibility. No roles → most
 * restrictive (external).
 */
export function audienceForRoles(
  roleIds: readonly string[],
  catalog: RoleManifestCatalog = loadRoleManifestCatalog()
): Audience {
  if (roleIds.length === 0) {
    return 'external'
  }
  const byId = new Map(catalog.roles.map((role) => [role.id, role]))
  const allExternal = roleIds.every((roleId) => byId.get(roleId)?.external === true)
  return allExternal ? 'external' : 'internal'
}

/** Resolves the caller's audience in an org from their membership roles (privileged
 *  read of their own membership). No membership → external (most restrictive). */
export async function resolveAudience(
  db: Kysely<Database>,
  organizationId: string,
  principal: { issuer: string; subject: string },
  catalog: RoleManifestCatalog = loadRoleManifestCatalog()
): Promise<Audience> {
  return withoutTenantContext(db, async (trx) => {
    const account = await findUserAccountBySubject(trx, principal.issuer, principal.subject)
    if (!account) {
      return 'external'
    }
    const membership = await trx
      .selectFrom('identity.memberships')
      .select('role_ids')
      .where('user_id', '=', account.id)
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .executeTakeFirst()
    return membership ? audienceForRoles(membership.role_ids, catalog) : 'external'
  })
}

/** Projects a work item for the audience: internal → full; external → internal-only
 *  fields omitted (not nulled — the key is absent). */
export function projectWorkItemForAudience(
  workItem: WorkItemResource,
  audience: Audience
): WorkItemResource | Omit<WorkItemResource, (typeof INTERNAL_WORK_ITEM_FIELDS)[number]> {
  if (audience === 'internal') {
    return workItem
  }
  const projected = { ...workItem } as Record<string, unknown>
  for (const field of INTERNAL_WORK_ITEM_FIELDS) {
    delete projected[field]
  }
  return projected as Omit<WorkItemResource, (typeof INTERNAL_WORK_ITEM_FIELDS)[number]>
}

/** Projects a project for the audience: external → internal delivery fields omitted. */
export function projectProjectForAudience(
  project: ProjectResource,
  audience: Audience
): ProjectResource | Omit<ProjectResource, (typeof INTERNAL_PROJECT_FIELDS)[number]> {
  if (audience === 'internal') {
    return project
  }
  const projected = { ...project } as Record<string, unknown>
  for (const field of INTERNAL_PROJECT_FIELDS) {
    delete projected[field]
  }
  return projected as Omit<ProjectResource, (typeof INTERNAL_PROJECT_FIELDS)[number]>
}

/** External audience sees only customer-visible comments; internal sees all. */
export function projectCommentsForAudience(
  comments: CommentResource[],
  audience: Audience
): CommentResource[] {
  if (audience === 'internal') {
    return comments
  }
  return comments.filter((comment) => comment.visibility === 'customer')
}
