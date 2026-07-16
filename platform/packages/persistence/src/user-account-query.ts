import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import { withoutTenantContext } from './tenant-transaction'

export type UserAccountRow = {
  id: string
  email: string
  displayName: string
}

export type ActiveMembershipRow = {
  organizationId: string
  roleIds: string[]
  createdAt: Date
}

/**
 * Resolves a verified issuer+subject to the Pie user account, or null if the
 * subject has never provisioned. Subject-scoped: the caller only ever passes its
 * OWN verified subject, so this reads a single row and never enumerates.
 */
export async function findUserAccountBySubject(
  trx: Transaction<Database>,
  issuer: string,
  subject: string
): Promise<UserAccountRow | null> {
  const row = await trx
    .selectFrom('identity.user_accounts')
    .select(['id', 'email', 'display_name'])
    .where('issuer', '=', issuer)
    .where('subject', '=', subject)
    .executeTakeFirst()
  return row ? { id: row.id, email: row.email, displayName: row.display_name } : null
}

/** Resolves the Pie user id for a verified subject (privileged, subject-scoped),
 *  or null if unprovisioned. */
export async function getUserIdForSubject(
  db: Kysely<Database>,
  issuer: string,
  subject: string
): Promise<string | null> {
  const account = await withoutTenantContext(db, (trx) =>
    findUserAccountBySubject(trx, issuer, subject)
  )
  return account?.id ?? null
}

/** The user's active memberships, earliest first (the earliest is their primary
 *  org for session selection). Runs in the privileged bootstrap path. */
export async function findActiveMemberships(
  trx: Transaction<Database>,
  userId: string
): Promise<ActiveMembershipRow[]> {
  const rows = await trx
    .selectFrom('identity.memberships')
    .select(['organization_id', 'role_ids', 'created_at'])
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .orderBy('created_at')
    .orderBy('organization_id')
    .execute()
  return rows.map((row) => ({
    organizationId: row.organization_id,
    roleIds: row.role_ids,
    createdAt: new Date(row.created_at)
  }))
}
