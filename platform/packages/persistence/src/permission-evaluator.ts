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

export type AuthorizationDecision =
  | { allowed: true; reason: 'allowed' }
  | { allowed: false; reason: AuthorizationDenialReason }

export type AuthorizationInput = {
  requiredPermission: string
  requestedOrganizationId: string
  // The caller's membership in the requested org, or null if they have none.
  membership: EvaluatorMembership | null
  // Permissions explicitly denied by a security policy (doc 01 step 3). No policy
  // table exists yet; the parameter keeps the step wired so a policy slice slots in.
  explicitDenies?: readonly string[]
}

/**
 * Judges one protected operation. Order (doc 01:215-231): (1) membership/session
 * active; (2) requested org matches the membership's org; (3) explicit deny +
 * policy first; (4) role grants the permission (resolved from the role manifest).
 * Resource-scope narrowing (step 5+) is deferred to the ResourceGrant slice and is
 * intentionally NOT faked here.
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
  if (!catalog.permissionsForRoles(membership.roleIds).includes(input.requiredPermission)) {
    return { allowed: false, reason: 'permission_denied' }
  }
  return { allowed: true, reason: 'allowed' }
}

// The audit action code for a denial. Distinct per reason so permission-denial and
// (future) entitlement-shortfall are never conflated in the audit trail (doc 11).
export function authorizationDenialAuditAction(reason: AuthorizationDenialReason): string {
  return `authz.denied.${reason}`
}
