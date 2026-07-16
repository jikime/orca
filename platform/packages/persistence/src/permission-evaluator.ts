import type { RoleManifestCatalog } from './role-manifest-catalog'

// Pure RBAC permission evaluation implementing the doc 01:215-231 judgment order.
// Default-deny; explicit deny beats allow. Kept PURE (no DB, no I/O) so the full
// role × permission matrix is exhaustively unit-testable (TEN-006 evidence). The
// entitlement axis (doc 11:47-60: organization entitlement → user permission →
// resource grant) is a SEPARATE later slice — the reason codes are kept distinct
// so an entitlement-shortfall never reads as a permission-denial.

export type EvaluatorMembership = {
  organizationId: string
  roleIds: string[]
  // 'active' | 'invited' | 'suspended' | 'revoked'
  status: string
}

export type AuthorizationDenialReason =
  | 'no_active_membership'
  | 'org_mismatch'
  | 'explicit_deny'
  | 'permission_denied'
  // A resource-scoped NARROW grant removed a permission the role otherwise grants.
  | 'resource_narrowed'

export type AuthorizationDecision =
  | { allowed: true; reason: 'allowed' }
  | { allowed: false; reason: AuthorizationDenialReason }

// A ResourceGrant that narrows (removes) or widens (exceptionally adds) a
// permission on ONE specific resource (doc 01:165-181).
export type ResourceGrantInput = {
  grantKind: 'narrow' | 'widen'
  resourceType: string
  resourceId: string
  permission: string
}

export type AuthorizationInput = {
  requiredPermission: string
  requestedOrganizationId: string
  // The caller's membership in the requested org, or null if they have none.
  membership: EvaluatorMembership | null
  // Permissions explicitly denied by a security policy (doc 01 step 3). No policy
  // table exists yet; the parameter keeps the step wired so a policy slice slots in.
  explicitDenies?: readonly string[]
  // The specific resource the operation targets, if any. When absent the decision
  // is org-level (role + permission only). When present, resourceGrants apply.
  resource?: { resourceType: string; resourceId: string }
  resourceGrants?: readonly ResourceGrantInput[]
}

/**
 * Judges one protected operation. Order (doc 01:215-231): (1) membership/session
 * active; (2) requested org matches the membership's org; (3) explicit deny +
 * policy first; (4) role grants the permission (role manifest); (5) resource scope
 * (doc 01:177): a NARROW grant removes the permission on the target resource even
 * if the role grants it; a WIDEN grant exceptionally adds it even if the role does
 * not. Default-deny throughout; explicit deny (step 3) beats a widen.
 */
export function evaluatePermission(
  input: AuthorizationInput,
  catalog: RoleManifestCatalog
): AuthorizationDecision {
  const membership = input.membership
  if (!membership || membership.status !== 'active') {
    return { allowed: false, reason: 'no_active_membership' }
  }
  if (membership.organizationId !== input.requestedOrganizationId) {
    return { allowed: false, reason: 'org_mismatch' }
  }
  if (input.explicitDenies?.includes(input.requiredPermission)) {
    return { allowed: false, reason: 'explicit_deny' }
  }

  const roleGrants = catalog
    .permissionsForRoles(membership.roleIds)
    .includes(input.requiredPermission)

  // Org-level (no specific resource): role decides.
  if (!input.resource) {
    return roleGrants
      ? { allowed: true, reason: 'allowed' }
      : { allowed: false, reason: 'permission_denied' }
  }

  // Resource-scoped: consult narrow/widen grants for THIS resource + permission.
  const relevant = (input.resourceGrants ?? []).filter(
    (grant) =>
      grant.resourceType === input.resource!.resourceType &&
      grant.resourceId === input.resource!.resourceId &&
      grant.permission === input.requiredPermission
  )
  if (relevant.some((grant) => grant.grantKind === 'narrow')) {
    return { allowed: false, reason: 'resource_narrowed' }
  }
  if (roleGrants) {
    return { allowed: true, reason: 'allowed' }
  }
  if (relevant.some((grant) => grant.grantKind === 'widen')) {
    return { allowed: true, reason: 'allowed' }
  }
  return { allowed: false, reason: 'permission_denied' }
}

// The audit action code for a denial. Distinct per reason so permission-denial and
// (future) entitlement-shortfall are never conflated in the audit trail (doc 11).
export function authorizationDenialAuditAction(reason: AuthorizationDenialReason): string {
  return `authz.denied.${reason}`
}
