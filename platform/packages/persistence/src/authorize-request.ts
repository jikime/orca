import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import {
  evaluatePermission,
  type AuthorizationDecision,
  type ResourceGrantInput
} from './permission-evaluator'
import { loadRoleManifestCatalog, type RoleManifestCatalog } from './role-manifest-catalog'
import { withoutTenantContext } from './tenant-transaction'
import { findUserAccountBySubject } from './user-account-query'

export type AuthorizationPrincipal = {
  issuer: string
  subject: string
}

export type AuthorizationResult = {
  decision: AuthorizationDecision
  // The Pie user id for the verified subject, or null if never provisioned.
  userId: string | null
}

/**
 * Resolves the caller's membership in the REQUESTED org and judges the required
 * permission (doc 01:215-231). The membership lookup is scoped to the requested
 * org, so a cross-org request (a member of org A asking about org B) finds no
 * membership and is denied 'no_active_membership' — the roadmap "다른 조직 ID를
 * 직접 요청해도 거부" exit criterion. Subject-scoped and privileged: it only ever
 * reads the caller's own account/membership.
 */
export async function authorizeSubjectForOrg(
  db: Kysely<Database>,
  principal: AuthorizationPrincipal,
  organizationId: string,
  requiredPermission: string,
  catalog: RoleManifestCatalog = loadRoleManifestCatalog()
): Promise<AuthorizationResult> {
  return withoutTenantContext(db, async (trx) => {
    const account = await findUserAccountBySubject(trx, principal.issuer, principal.subject)
    if (!account) {
      return {
        decision: evaluatePermission(
          { requiredPermission, requestedOrganizationId: organizationId, membership: null },
          catalog
        ),
        userId: null
      }
    }
    const membership = await trx
      .selectFrom('identity.memberships')
      .select(['role_ids', 'status'])
      .where('user_id', '=', account.id)
      .where('organization_id', '=', organizationId)
      .executeTakeFirst()
    const decision = evaluatePermission(
      {
        requiredPermission,
        requestedOrganizationId: organizationId,
        membership: membership
          ? { organizationId, roleIds: membership.role_ids, status: membership.status }
          : null
      },
      catalog
    )
    return { decision, userId: account.id }
  })
}

/**
 * Resource-scoped authorization (doc 01:165-181): resolves the caller's membership
 * AND their resource grants (narrow/widen) for the target resource, then runs the
 * evaluator's resource-scope step. R4's resource-scoped operations (getProject, ...)
 * are the ResourceGrant evaluator's first real consumers. Privileged/subject-scoped.
 */
export async function authorizeSubjectForResource(
  db: Kysely<Database>,
  principal: AuthorizationPrincipal,
  organizationId: string,
  resource: { resourceType: string; resourceId: string },
  requiredPermission: string,
  catalog: RoleManifestCatalog = loadRoleManifestCatalog()
): Promise<AuthorizationResult> {
  return withoutTenantContext(db, async (trx) => {
    const account = await findUserAccountBySubject(trx, principal.issuer, principal.subject)
    if (!account) {
      return {
        decision: evaluatePermission(
          {
            requiredPermission,
            requestedOrganizationId: organizationId,
            membership: null,
            resource
          },
          catalog
        ),
        userId: null
      }
    }
    const membership = await trx
      .selectFrom('identity.memberships')
      .select(['role_ids', 'status'])
      .where('user_id', '=', account.id)
      .where('organization_id', '=', organizationId)
      .executeTakeFirst()
    const grantRows = await trx
      .selectFrom('identity.resource_grants')
      .select(['grant_kind', 'resource_type', 'resource_id', 'permission'])
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', account.id)
      .where('resource_type', '=', resource.resourceType)
      .where('resource_id', '=', resource.resourceId)
      .execute()
    const resourceGrants: ResourceGrantInput[] = grantRows.map((row) => ({
      grantKind: row.grant_kind === 'widen' ? 'widen' : 'narrow',
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      permission: row.permission
    }))
    const decision = evaluatePermission(
      {
        requiredPermission,
        requestedOrganizationId: organizationId,
        membership: membership
          ? { organizationId, roleIds: membership.role_ids, status: membership.status }
          : null,
        resource,
        resourceGrants
      },
      catalog
    )
    return { decision, userId: account.id }
  })
}

export type AuthorizationDenialAudit = {
  // The org the caller REQUESTED; may not exist. Stored as plain data (no FK).
  requestedOrganizationId: string
  userId: string | null
  issuer: string
  subject: string
  requiredPermission: string
  requestId?: string | null
}

/**
 * Records a denied authorization attempt in the non-org-scoped security stream
 * (doc 01 step 8, doc 11 distinct codes). This CANNOT depend on the requested org
 * existing — a denial for a non-existent/foreign org must still be a clean 403,
 * so the write is privileged, FK-free, and best-effort: any failure is swallowed
 * so the audit can never escalate a deny into a 500. Denials — not allows — are
 * the security-relevant events; allow-path changes are audited at the mutation.
 */
export async function recordAuthorizationDenial(
  db: Kysely<Database>,
  decision: Extract<AuthorizationDecision, { allowed: false }>,
  audit: AuthorizationDenialAudit
): Promise<void> {
  try {
    await withoutTenantContext(db, async (trx) => {
      await trx
        .insertInto('audit.authorization_denials')
        .values({
          requested_organization_id: audit.requestedOrganizationId,
          actor_user_id: audit.userId,
          issuer: audit.issuer,
          subject: audit.subject,
          permission: audit.requiredPermission,
          reason: decision.reason,
          request_id: audit.requestId ?? null
        })
        .execute()
    })
  } catch {
    // Best-effort: the security event is important, but it must NEVER turn a clean
    // 403 into a 500. The FK-free table makes a failure here unexpected; guard anyway.
  }
}
