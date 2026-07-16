import { describe, expect, it } from 'vitest'
import { loadRoleManifestCatalog } from './role-manifest-catalog'
import { evaluateEntitlement } from './entitlement-evaluator'
import {
  authorizationDenialAuditAction,
  evaluatePermission,
  type EvaluatorMembership,
  type ResourceGrantInput
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
// security-gates.json). This describe covers the role/permission axis exhaustively
// over the 7 fixed roles; the entitlement and resource-grant axes (now real) are
// exercised below, and the combined four-distinct-outcomes test is at the end.

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
    '$role: allows a granted permission and denies an ungranted one',
    ({ role, granted, denied }) => {
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

const RESOURCE = { resourceType: 'project', resourceId: '33333333-3333-4333-8333-333333333333' }

function grant(kind: 'narrow' | 'widen', permission: string): ResourceGrantInput {
  return {
    grantKind: kind,
    resourceType: RESOURCE.resourceType,
    resourceId: RESOURCE.resourceId,
    permission
  }
}

describe('resource-scope step (ResourceGrant)', () => {
  it('a NARROW grant removes a permission the role otherwise grants', () => {
    const decision = evaluatePermission(
      {
        requiredPermission: 'project.update',
        requestedOrganizationId: ORG,
        membership: membership(['project_manager']),
        resource: RESOURCE,
        resourceGrants: [grant('narrow', 'project.update')]
      },
      catalog
    )
    expect(decision).toEqual({ allowed: false, reason: 'resource_narrowed' })
  })

  it('a WIDEN grant adds a permission the role lacks', () => {
    const decision = evaluatePermission(
      {
        requiredPermission: 'project.archive',
        requestedOrganizationId: ORG,
        membership: membership(['member']),
        resource: RESOURCE,
        resourceGrants: [grant('widen', 'project.archive')]
      },
      catalog
    )
    expect(decision).toEqual({ allowed: true, reason: 'allowed' })
  })

  it('with no grant, the role default applies on the resource', () => {
    const allowed = evaluatePermission(
      {
        requiredPermission: 'project.update',
        requestedOrganizationId: ORG,
        membership: membership(['project_manager']),
        resource: RESOURCE
      },
      catalog
    )
    expect(allowed.allowed).toBe(true)
    const denied = evaluatePermission(
      {
        requiredPermission: 'project.archive',
        requestedOrganizationId: ORG,
        membership: membership(['member']),
        resource: RESOURCE
      },
      catalog
    )
    expect(denied).toEqual({ allowed: false, reason: 'permission_denied' })
  })

  it('an explicit deny beats a widen grant', () => {
    const decision = evaluatePermission(
      {
        requiredPermission: 'project.archive',
        requestedOrganizationId: ORG,
        membership: membership(['member']),
        resource: RESOURCE,
        resourceGrants: [grant('widen', 'project.archive')],
        explicitDenies: ['project.archive']
      },
      catalog
    )
    expect(decision).toEqual({ allowed: false, reason: 'explicit_deny' })
  })
})

// The combined TEN-006 matrix: org entitlement × user permission × resource grant
// produce FOUR DISTINCT outcomes with FOUR DISTINCT reason codes.
describe('permission-entitlement-combination-matrix: four distinct outcomes (TEN-006)', () => {
  it('entitlement_shortfall ≠ permission_denied ≠ resource_narrowed ≠ allowed', () => {
    // 1. entitlement-shortfall (org over member limit) — the ENTITLEMENT axis.
    const entitlement = evaluateEntitlement({
      enforcement: 'limit',
      grantValue: 1,
      currentUsage: 1,
      increment: 1
    })
    expect(entitlement).toEqual({ allowed: false, reason: 'entitlement_shortfall' })

    // 2. permission-denied — the ROLE axis (org has capacity, user lacks permission).
    const permission = evaluatePermission(
      {
        requiredPermission: 'organization.manage',
        requestedOrganizationId: ORG,
        membership: membership(['member'])
      },
      catalog
    )
    expect(permission).toEqual({ allowed: false, reason: 'permission_denied' })

    // 3. resource-narrowed — the RESOURCE-GRANT axis (role grants, grant removes).
    const resource = evaluatePermission(
      {
        requiredPermission: 'project.update',
        requestedOrganizationId: ORG,
        membership: membership(['project_manager']),
        resource: RESOURCE,
        resourceGrants: [grant('narrow', 'project.update')]
      },
      catalog
    )
    expect(resource).toEqual({ allowed: false, reason: 'resource_narrowed' })

    // 4. allowed — all three axes pass.
    const allowed = evaluatePermission(
      {
        requiredPermission: 'project.update',
        requestedOrganizationId: ORG,
        membership: membership(['project_manager'])
      },
      catalog
    )
    expect(allowed).toEqual({ allowed: true, reason: 'allowed' })

    // Four distinct reason codes.
    const reasons = new Set([
      entitlement.reason,
      permission.reason,
      resource.reason,
      allowed.reason
    ])
    expect(reasons.size).toBe(4)
  })
})
