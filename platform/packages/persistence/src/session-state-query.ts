import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { loadRoleManifestCatalog, type RoleManifestCatalog } from './role-manifest-catalog'
import { withoutTenantContext } from './tenant-transaction'
import { findActiveMemberships, findUserAccountBySubject } from './user-account-query'

// A verified token principal. The verifier (control-plane-api) produces this; the
// query layer never trusts an unverified subject.
export type SessionPrincipal = {
  issuer: string
  subject: string
  expiresAt: string
}

// Matches contracts/schemas/resources/session-state.v1: signed_out carries only
// the instance id; signed_in carries the resolved Pie session. reauth_required is
// reserved for the R3 token-refresh flows (slice 2/3); slice 1 emits signed_out
// or signed_in only.
export type SessionState =
  | { status: 'signed_out'; instanceId: string }
  | {
      status: 'signed_in'
      instanceId: string
      userId: string
      displayName: string
      organizationId: string
      permissions: string[]
      expiresAt: string
    }

export type SessionStateInput = {
  instanceId: string
  // null when there is no bearer token or it failed verification.
  principal: SessionPrincipal | null
}

/**
 * Resolves the desktop session state from a verified principal. No/invalid token
 * OR a verified subject with no active Pie membership both yield signed_out — the
 * schema has no "authenticated but org-less" state, and honestly there is no Pie
 * session until a membership exists (the client then provisions). Permissions come
 * from the role manifest (source of truth), not the token's claims (ADR-0009 §7).
 * Runs privileged and subject-scoped: it only ever reads the caller's own rows.
 */
export async function getSessionState(
  db: Kysely<Database>,
  input: SessionStateInput,
  catalog: RoleManifestCatalog = loadRoleManifestCatalog()
): Promise<SessionState> {
  if (!input.principal) {
    return { status: 'signed_out', instanceId: input.instanceId }
  }
  const principal = input.principal
  return withoutTenantContext(db, async (trx) => {
    const account = await findUserAccountBySubject(trx, principal.issuer, principal.subject)
    if (!account) {
      return { status: 'signed_out', instanceId: input.instanceId }
    }
    const memberships = await findActiveMemberships(trx, account.id)
    const primary = memberships[0]
    if (!primary) {
      return { status: 'signed_out', instanceId: input.instanceId }
    }
    return {
      status: 'signed_in',
      instanceId: input.instanceId,
      userId: account.id,
      displayName: account.displayName,
      organizationId: primary.organizationId,
      permissions: catalog.permissionsForRoles(primary.roleIds),
      expiresAt: principal.expiresAt
    }
  })
}
