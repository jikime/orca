import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

const OWNER_ROLE_ID = 'organization_owner'

export type RevokeMembershipResult =
  | { outcome: 'revoked'; targetUserId: string }
  | { outcome: 'not_a_member' }
  // The last active organization_owner cannot be removed — ownership must be
  // transferred or the org closed first (doc 01:79, TEN-005).
  | { outcome: 'last_owner_blocked' }

/**
 * Revokes a member's standing in an org (status → revoked). The RBAC gate denies
 * a non-active membership on the very next request, so authorization drops
 * immediately (AUT-005). Concurrency-safe last-owner protection: the active owner
 * memberships are locked FOR UPDATE and re-counted inside the transaction, so two
 * simultaneous last-owner removals serialize and only one can win — the second
 * sees a single remaining owner and is blocked.
 */
export async function revokeMembership(
  db: Kysely<Database>,
  input: {
    organizationId: string
    targetUserId: string
    actorUserId: string
    reason?: string
  }
): Promise<RevokeMembershipResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    // Lock the org's active owner memberships first so concurrent removals block
    // on each other and re-evaluate the owner count serially.
    const owners = await trx
      .selectFrom('identity.memberships')
      .select(['user_id'])
      .where('status', '=', 'active')
      .where(sql<boolean>`${OWNER_ROLE_ID} = any(role_ids)`)
      .forUpdate()
      .execute()

    const target = await trx
      .selectFrom('identity.memberships')
      .select(['id', 'role_ids', 'status'])
      .where('user_id', '=', input.targetUserId)
      .where('status', '=', 'active')
      .executeTakeFirst()
    if (!target) {
      return { outcome: 'not_a_member' }
    }
    const targetIsOwner = target.role_ids.includes(OWNER_ROLE_ID)
    if (targetIsOwner && owners.length <= 1) {
      return { outcome: 'last_owner_blocked' }
    }

    await trx
      .updateTable('identity.memberships')
      .set({ status: 'revoked', updated_at: sql`now()` })
      .where('id', '=', target.id)
      .execute()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'membership.revoked',
        target_type: 'membership',
        target_id: target.id
      })
      .execute()
    return { outcome: 'revoked', targetUserId: input.targetUserId }
  })
}
