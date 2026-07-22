import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withoutTenantContext, withTenantTransaction } from './tenant-transaction'
import { findUserAccountBySubject } from './user-account-query'
import type { SessionPrincipal } from './session-state-query'

// Shape of contracts/schemas/resources/membership.v1.
export type MembershipResource = {
  id: string
  organizationId: string
  userId: string
  displayName: string
  status: string
  roleIds: string[]
  version: number
  createdAt: string
  updatedAt: string
}

export type ListMembershipsResult =
  | { ok: true; items: MembershipResource[] }
  // The caller has no active membership in the org (or has not provisioned) — the
  // route turns this into a 403 without confirming the org's internal topology.
  | { ok: false; reason: 'not_a_member' }

/**
 * Lists an org's memberships for a caller who is themselves an active member of
 * that org. The membership check is app-layer (doc 01 permission judgment step 1):
 * RLS scopes rows to the chosen org, but the org is chosen from the PATH, so RLS
 * alone would not stop a non-member from listing — hence the explicit gate here.
 */
export async function listMembershipsForMember(
  db: Kysely<Database>,
  principal: SessionPrincipal,
  organizationId: string,
  options: { query?: string; limit?: number } = {}
): Promise<ListMembershipsResult> {
  const isMember = await withoutTenantContext(db, async (trx) => {
    const account = await findUserAccountBySubject(trx, principal.issuer, principal.subject)
    if (!account) {
      return false
    }
    const membership = await trx
      .selectFrom('identity.memberships')
      .select('id')
      .where('user_id', '=', account.id)
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .executeTakeFirst()
    return Boolean(membership)
  })
  if (!isMember) {
    return { ok: false, reason: 'not_a_member' }
  }

  const items = await withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('identity.memberships as membership')
      .innerJoin('identity.user_accounts as account', 'account.id', 'membership.user_id')
      .selectAll('membership')
      .select('account.display_name')
      .where('membership.status', '=', 'active')
      .orderBy('account.display_name', 'asc')
      .limit(Math.min(Math.max(options.limit ?? 50, 1), 100))
    const search = options.query?.trim()
    if (search) {
      // Why: member search is display-name based; opaque ids remain selectable but are not exposed
      // through wildcard casts that can bypass a future identity index.
      query = query.where('account.display_name', 'ilike', `%${search.replaceAll('%', '\\%')}%`)
    }
    const rows = await query.execute()
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      userId: row.user_id,
      displayName: row.display_name,
      status: row.status,
      roleIds: row.role_ids,
      version: Number(row.version),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    }))
  })
  return { ok: true, items }
}
