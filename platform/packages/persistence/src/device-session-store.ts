import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withoutTenantContext } from './tenant-transaction'

// Pie-side session records for revocation propagation. Keyed on the Keycloak
// session id (`sid`). Keycloak owns credential + refresh-token rotation; Pie owns
// the session metadata, the revoke DECISION, and next-request enforcement via the
// verifier. All operations run privileged (withoutTenantContext) — sessions are
// global, not org-scoped, and never touched through a tenant request.

export type DeviceSessionRecord = {
  sessionId: string
  familyId: string
  status: string
  rotationCounter: number
}

/** Establishes (or refreshes) the Pie session record at login. Keyed on the sid;
 *  a re-login with the same sid keeps its family. */
export async function recordDeviceSession(
  db: Kysely<Database>,
  input: { sessionId: string; userId: string; issuer: string; subject: string }
): Promise<DeviceSessionRecord> {
  return withoutTenantContext(db, async (trx) => {
    const row = await trx
      .insertInto('identity.device_sessions')
      .values({
        session_id: input.sessionId,
        user_id: input.userId,
        issuer: input.issuer,
        subject: input.subject
      })
      .onConflict((oc) => oc.column('session_id').doUpdateSet({ last_seen_at: sql`now()` }))
      .returning(['session_id', 'family_id', 'status', 'rotation_counter'])
      .executeTakeFirstOrThrow()
    return {
      sessionId: row.session_id,
      familyId: row.family_id,
      status: row.status,
      rotationCounter: Number(row.rotation_counter)
    }
  })
}

/**
 * The verifier's revocation check: true when the session id has been recorded AND
 * revoked. An unknown sid is NOT revoked (the session simply hasn't been recorded
 * yet). Read-only and indexed — cheap on every request.
 */
export async function isSessionRevoked(db: Kysely<Database>, sessionId: string): Promise<boolean> {
  const row = await withoutTenantContext(db, (trx) =>
    trx
      .selectFrom('identity.device_sessions')
      .select('status')
      .where('session_id', '=', sessionId)
      .executeTakeFirst()
  )
  return row?.status === 'revoked'
}

export type RevokeReason =
  | 'user_logout'
  | 'admin_revoke'
  | 'account_disabled'
  | 'membership_revoked'
  | 'security_policy'

/** Revokes one session. The verifier rejects its token at the next request. */
export async function revokeSession(
  db: Kysely<Database>,
  input: { sessionId: string; reason: RevokeReason }
): Promise<void> {
  await withoutTenantContext(db, (trx) =>
    trx
      .updateTable('identity.device_sessions')
      .set({ status: 'revoked', revoked_reason: input.reason, revoked_at: sql`now()` })
      .where('session_id', '=', input.sessionId)
      .where('status', '=', 'active')
      .execute()
  )
}

/** Revokes all of a user's sessions, optionally keeping the current one
 *  (revoke-all vs revoke-all-but-current, doc 01:157). */
export async function revokeUserSessions(
  db: Kysely<Database>,
  input: { userId: string; reason: RevokeReason; exceptSessionId?: string }
): Promise<number> {
  return withoutTenantContext(db, async (trx) => {
    let query = trx
      .updateTable('identity.device_sessions')
      .set({ status: 'revoked', revoked_reason: input.reason, revoked_at: sql`now()` })
      .where('user_id', '=', input.userId)
      .where('status', '=', 'active')
    if (input.exceptSessionId) {
      query = query.where('session_id', '!=', input.exceptSessionId)
    }
    const result = await query.execute()
    return Number(result[0]?.numUpdatedRows ?? 0n)
  })
}

export type RotationOutcome =
  | { outcome: 'rotated'; rotationCounter: number }
  | { outcome: 'reuse_revoked' }
  | { outcome: 'unknown_session' }

/**
 * Refresh-token-family rotation + reuse detection (AUT-002). The client presents
 * the rotation counter it currently holds. If it matches the family's current
 * counter, we advance it (a normal rotation). If it is STALE (an already-rotated-
 * away value is replayed — the classic refresh-token reuse attack), we revoke the
 * ENTIRE family. Pie owns this decision; Keycloak owns the actual token rotation
 * (see docs for the boundary).
 */
export async function rotateSessionFamily(
  db: Kysely<Database>,
  input: { sessionId: string; presentedRotation: number; reason?: RevokeReason }
): Promise<RotationOutcome> {
  return withoutTenantContext(db, async (trx) => {
    const session = await trx
      .selectFrom('identity.device_sessions')
      .select(['family_id', 'rotation_counter', 'status'])
      .where('session_id', '=', input.sessionId)
      .forUpdate()
      .executeTakeFirst()
    if (!session || session.status !== 'active') {
      return { outcome: 'unknown_session' }
    }
    const current = Number(session.rotation_counter)
    if (input.presentedRotation !== current) {
      // Stale (or forged) rotation marker replayed → revoke the whole family.
      await trx
        .updateTable('identity.device_sessions')
        .set({
          status: 'revoked',
          revoked_reason: input.reason ?? 'security_policy',
          revoked_at: sql`now()`
        })
        .where('family_id', '=', session.family_id)
        .where('status', '=', 'active')
        .execute()
      return { outcome: 'reuse_revoked' }
    }
    const next = current + 1
    await trx
      .updateTable('identity.device_sessions')
      .set({ rotation_counter: next, last_seen_at: sql`now()` })
      .where('session_id', '=', input.sessionId)
      .execute()
    return { outcome: 'rotated', rotationCounter: next }
  })
}
