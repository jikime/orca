import { describe, expect, it } from 'vitest'
import { loadRoleManifestCatalog } from './role-manifest-catalog'
import {
  authorizationDenialAuditAction,
  evaluatePermission,
  type EvaluatorMembership
} from './permission-evaluator'

const catalog = loadRoleManifestCatalog()
const ORG = '11111111-1111-1111-1111-111111111111'

function membership(
  roleIds: string[],
  overrides: Partial<EvaluatorMembership> = {}
): EvaluatorMembership {
  return { organizationId: ORG, roleIds, status: 'active', ...overrides }
}

// TEN-006 permission-entitlement-combination-matrix (contracts/manifests/
// security-gates.json). The permission axis is exhaustive over the 7 fixed roles;
// the entitlement axis is a documented stub column (organization entitlement is a
// later slice, doc 11:47-60) so the matrix structure already has a slot for it.
const ENTITLEMENT_AXIS_STUB = 'unlimited' as const

// One representative permission per role that the role SHOULD have, and one it
// should NOT, derived from contracts/manifests/roles.json.
const ROLE_MATRIX: { role: string; granted: string; denied: string }[] = [
  { role: 'organization_owner', granted: 'organization.manage', denied: 'nonexistent.permission' },
  { role: 'organization_admin', granted: 'member.manage', denied: 'organization.manage' },
  { role: 'project_manager', granted: 'member.read', denied: 'member.manage' },
  { role: 'member', granted: 'work_item.create', denied: 'member.read' },
  { role: 'customer_approver', granted: 'organization.read', denied: 'artifact.publish' },
  { role: 'partner', granted: 'artifact.publish', denied: 'member.read' },
  { role: 'guest', granted: 'work_item.read', denied: 'organization.read' }
]

describe('RBAC permission matrix (TEN-006)', () => {
  it.each(ROLE_MATRIX)(
    '$role: allows a granted permission and denies an ungranted one (entitlement axis: stub)',
    ({ role, granted, denied }) => {
      void ENTITLEMENT_AXIS_STUB
      const allow = evaluatePermission(
        {
          requiredPermission: granted,
          requestedOrganizationId: ORG,
          membership: membership([role])
        },
        catalog
      )
      expect(allow).toEqual({ allowed: true, reason: 'allowed' })

      const deny = evaluatePermission(
        {
          requiredPermission: denied,
          requestedOrganizationId: ORG,
          membership: membership([role])
        },
        catalog
      )
      expect(deny.allowed).toBe(false)
      if (!deny.allowed) {
        expect(deny.reason).toBe('permission_denied')
      }
    }
  )

  it('denies when there is no membership (default-deny)', () => {
    const decision = evaluatePermission(
      { requiredPermission: 'organization.read', requestedOrganizationId: ORG, membership: null },
      catalog
    )
    expect(decision).toEqual({ allowed: false, reason: 'no_active_membership' })
  })

  it('denies a non-active membership', () => {
    const decision = evaluatePermission(
      {
        requiredPermission: 'organization.read',
        requestedOrganizationId: ORG,
        membership: membership(['organization_owner'], { status: 'suspended' })
      },
      catalog
    )
    expect(decision).toEqual({ allowed: false, reason: 'no_active_membership' })
  })

  it('denies a cross-org request (membership org ≠ requested org)', () => {
    const decision = evaluatePermission(
      {
        requiredPermission: 'organization.read',
        requestedOrganizationId: ORG,
        membership: membership(['organization_owner'], {
          organizationId: '22222222-2222-2222-2222-222222222222'
        })
      },
      catalog
    )
    expect(decision).toEqual({ allowed: false, reason: 'org_mismatch' })
  })

  it('applies explicit deny before checking the role (deny beats allow)', () => {
    const decision = evaluatePermission(
      {
        requiredPermission: 'organization.manage',
        requestedOrganizationId: ORG,
        membership: membership(['organization_owner']),
        explicitDenies: ['organization.manage']
      },
      catalog
    )
    expect(decision).toEqual({ allowed: false, reason: 'explicit_deny' })
  })

  it('unions permissions across multiple roles', () => {
    const decision = evaluatePermission(
      {
        requiredPermission: 'member.manage',
        requestedOrganizationId: ORG,
        membership: membership(['member', 'organization_admin'])
      },
      catalog
    )
    expect(decision.allowed).toBe(true)
  })

  it('emits distinct audit action codes per denial reason', () => {
    expect(authorizationDenialAuditAction('permission_denied')).toBe(
      'authz.denied.permission_denied'
    )
    expect(authorizationDenialAuditAction('org_mismatch')).toBe('authz.denied.org_mismatch')
    expect(authorizationDenialAuditAction('no_active_membership')).toBe(
      'authz.denied.no_active_membership'
    )
  })
})
