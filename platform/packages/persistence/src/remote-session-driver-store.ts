import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
// Reuse A1's authority check + audit writer + session loader — driver arbitration is NOT a second
// source of truth; it defers to the SAME host/admin authority and the SAME audit stream.
import {
  isRemoteSessionAdminTx,
  loadRemoteSessionTx,
  writeRemoteSessionAudit
} from './remote-session-store'
import { withTenantTransaction } from './tenant-transaction'

// R8 slice A3: single-driver (single-operator) arbitration + takeover audit (doc 34 §슬라이스 A3,
// §보안 제약 #2 승인자≠조작자 = approver≠operator + all takeover audited, doc 07 "한 명만 조작 가능한
// 자원은 현재 드라이버를 명시한다" / "조작권 전달·회수"). Exactly ONE participant holds the driver role
// for a session at a time. Driver is GRANTED by an approver (host/admin) to an operator — never
// self-granted. A handoff transfers it atomically; a revoke clears it. Every takeover is audited.

// Only these grades may operate an exclusive resource (doc 07 ascending 권한 등급: terminal_control
// and above can drive; admin manages and may also drive).
const DRIVER_ELIGIBLE_GRADES = new Set<string>(['terminal_control', 'desktop_control', 'admin'])

// The current driver as returned to callers: the active grant joined with its operator participant.
export type ActiveDriver = {
  grantId: string
  sessionId: string
  operatorParticipantId: string
  operatorUserId: string
  approverUserId: string
  capabilityId: string | null
  grantedAt: string
}

// Reads the active (non-revoked) driver grant joined with its operator participant. At most one row
// exists per session (the partial-unique index) so this is the single-driver read.
async function loadActiveDriverTx(
  trx: Transaction<Database>,
  sessionId: string
): Promise<ActiveDriver | null> {
  const row = await trx
    .selectFrom('support.remote_session_driver_grants as g')
    .innerJoin('support.remote_session_participants as p', 'p.id', 'g.operator_participant_id')
    .select([
      'g.id as grant_id',
      'g.session_id as session_id',
      'g.operator_participant_id as operator_participant_id',
      'g.approver_user_id as approver_user_id',
      'g.capability_id as capability_id',
      'g.granted_at as granted_at',
      'p.user_id as operator_user_id'
    ])
    .where('g.session_id', '=', sessionId)
    .where('g.revoked_at', 'is', null)
    .executeTakeFirst()
  if (!row) {
    return null
  }
  return {
    grantId: row.grant_id,
    sessionId: row.session_id,
    operatorParticipantId: row.operator_participant_id,
    operatorUserId: row.operator_user_id,
    approverUserId: row.approver_user_id,
    capabilityId: row.capability_id,
    grantedAt: new Date(row.granted_at).toISOString()
  }
}

// Revokes the active grant (if any) and clears the operator's is_driver flag, auditing
// driver_revoked. Shared by revokeDriver, the handoff path, and A1's end-of-session hook. Returns
// the just-revoked driver (or null when there was none). `now` is injected.
export async function revokeActiveDriverForSessionTx(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    sessionId: string
    reason: string
    actorUserId: string | null
    now: Date
  }
): Promise<ActiveDriver | null> {
  const active = await loadActiveDriverTx(trx, input.sessionId)
  if (!active) {
    return null
  }
  await trx
    .updateTable('support.remote_session_driver_grants')
    .set({ revoked_at: input.now, revoke_reason: input.reason })
    .where('session_id', '=', input.sessionId)
    .where('id', '=', active.grantId)
    .where('revoked_at', 'is', null)
    .execute()
  await trx
    .updateTable('support.remote_session_participants')
    .set({ is_driver: false })
    .where('id', '=', active.operatorParticipantId)
    .execute()
  await writeRemoteSessionAudit(trx, {
    organizationId: input.organizationId,
    sessionId: input.sessionId,
    eventType: 'driver_revoked',
    actorUserId: input.actorUserId,
    detail: {
      grantId: active.grantId,
      operatorParticipantId: active.operatorParticipantId,
      operatorUserId: active.operatorUserId,
      reason: input.reason
    }
  })
  return active
}

export type GrantDriverResult =
  | { ok: true; driver: ActiveDriver }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'session_terminal'
        | 'forbidden'
        | 'operator_not_eligible'
        | 'approver_is_operator'
    }

/**
 * Grants (or hands off) the exclusive driver role to an operator (doc 34 §슬라이스 A3). In one tenant
 * tx it asserts: the session is not terminal (ended/reviewed → `session_terminal`); the approver is
 * the host or an admin participant (A1 authority) else `forbidden`; the operator participant exists,
 * has not left, and has a control-capable grade else `operator_not_eligible`; and — the doc 34
 * §보안 제약 #2 separation — the approver's user differs from the operator's user else
 * `approver_is_operator`. If a driver already exists it is REVOKED first (audited driver_revoked),
 * then the new grant is inserted, the operator's is_driver flag is set, and driver_granted is audited
 * with the from/to operator. Atomic handoff — the single-active partial-unique index holds. `now` is
 * injected so the store is deterministic under test.
 */
export async function grantDriver(
  db: Kysely<Database>,
  input: {
    organizationId: string
    approverUserId: string
    sessionId: string
    operatorParticipantId: string
    capabilityId?: string
    now: Date
  }
): Promise<GrantDriverResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await loadRemoteSessionTx(trx, input.sessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    if (session.status === 'ended' || session.status === 'reviewed') {
      return { ok: false, reason: 'session_terminal' }
    }
    if (
      !(await isRemoteSessionAdminTx(trx, session.id, input.approverUserId, session.hostUserId))
    ) {
      return { ok: false, reason: 'forbidden' }
    }
    const operator = await trx
      .selectFrom('support.remote_session_participants')
      .select(['id', 'user_id', 'grade', 'left_at'])
      .where('id', '=', input.operatorParticipantId)
      .where('session_id', '=', session.id)
      .executeTakeFirst()
    if (!operator || operator.left_at !== null || !DRIVER_ELIGIBLE_GRADES.has(operator.grade)) {
      return { ok: false, reason: 'operator_not_eligible' }
    }
    // doc 34 §보안 제약 #2: 승인자 ≠ 조작자. The approver may never make themselves the driver.
    if (operator.user_id === input.approverUserId) {
      return { ok: false, reason: 'approver_is_operator' }
    }
    // Atomic handoff: revoke the prior driver (audited) BEFORE inserting the new grant, so the
    // single-active partial-unique index never sees two live rows.
    const previous = await revokeActiveDriverForSessionTx(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      reason: 'driver_handoff',
      actorUserId: input.approverUserId,
      now: input.now
    })
    const inserted = await trx
      .insertInto('support.remote_session_driver_grants')
      .values({
        organization_id: input.organizationId,
        session_id: session.id,
        operator_participant_id: input.operatorParticipantId,
        approver_user_id: input.approverUserId,
        capability_id: input.capabilityId ?? null,
        granted_at: input.now
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await trx
      .updateTable('support.remote_session_participants')
      .set({ is_driver: true })
      .where('id', '=', input.operatorParticipantId)
      .execute()
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      eventType: 'driver_granted',
      actorUserId: input.approverUserId,
      detail: {
        grantId: inserted.id,
        toParticipantId: input.operatorParticipantId,
        toUserId: operator.user_id,
        fromParticipantId: previous?.operatorParticipantId ?? null,
        fromUserId: previous?.operatorUserId ?? null,
        capabilityId: input.capabilityId ?? null
      }
    })
    return {
      ok: true,
      driver: {
        grantId: inserted.id,
        sessionId: session.id,
        operatorParticipantId: input.operatorParticipantId,
        operatorUserId: operator.user_id,
        approverUserId: input.approverUserId,
        capabilityId: input.capabilityId ?? null,
        grantedAt: new Date(inserted.granted_at).toISOString()
      }
    }
  })
}

export type RevokeDriverResult =
  | { ok: true; revoked: boolean }
  | { ok: false; reason: 'not_found' | 'forbidden' }

/**
 * Clears the active driver (doc 07 조작권 회수). The host/an admin — or the driver revoking
 * themselves — may revoke. Idempotent: with no active driver it is a no-op success. Audits
 * driver_revoked. `now` is injected.
 */
export async function revokeDriver(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    sessionId: string
    reason?: string
    now: Date
  }
): Promise<RevokeDriverResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await loadRemoteSessionTx(trx, input.sessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    const active = await loadActiveDriverTx(trx, session.id)
    if (!active) {
      // Nothing to revoke — idempotent no-op (the resource gate already covered authz).
      return { ok: true, revoked: false }
    }
    const isAdmin = await isRemoteSessionAdminTx(
      trx,
      session.id,
      input.actorUserId,
      session.hostUserId
    )
    // The current driver may relinquish their own role; otherwise host/admin authority is required.
    if (!isAdmin && active.operatorUserId !== input.actorUserId) {
      return { ok: false, reason: 'forbidden' }
    }
    await revokeActiveDriverForSessionTx(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      reason: input.reason ?? 'driver_revoked',
      actorUserId: input.actorUserId,
      now: input.now
    })
    return { ok: true, revoked: true }
  })
}

/** Reads the current driver of a session (org-scoped), or null when there is none. */
export async function getActiveDriver(
  db: Kysely<Database>,
  organizationId: string,
  sessionId: string
): Promise<ActiveDriver | null> {
  return withTenantTransaction(db, organizationId, (trx) => loadActiveDriverTx(trx, sessionId))
}
