import { randomUUID } from 'node:crypto'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
// Slice A2: ending a session revokes its live capabilities in the same tx (doc 34 §보안 제약 #7).
// This module<->capability-store cycle is import-safe: both sides only call across the boundary
// inside function bodies, never at module top level.
import { revokeCapabilitiesForSessionTx } from './remote-session-capability-store'
import { buildResourceChangeCloudEvent } from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

// R8 slice A1: RemoteSession control-plane authority (doc 34 Phase A, doc 07 원격지원).
// The Control Plane is the sole source of truth for session lifecycle, roster, consent,
// and audit. The Relay stream ferry and the Orca client are LATER phases — nothing here
// touches PTY, streaming, or capability tokens.

export type RemoteSessionKind = 'terminal' | 'desktop' | 'support'

export type RemoteSessionStatus =
  | 'requested'
  | 'awaiting_consent'
  | 'connecting'
  | 'active'
  | 'paused'
  | 'ended'
  | 'reviewed'

// Ascending 권한 등급 (doc 07): 관전 < 채팅 < 터미널조작 < 데스크톱조작 < 파일전송 < 관리자.
export type ParticipantGrade =
  | 'observer'
  | 'chat'
  | 'terminal_control'
  | 'desktop_control'
  | 'file_transfer'
  | 'admin'

// The doc 07 state machine. Every non-terminal state may jump straight to `ended` — the
// emergency stop / consent-revocation safe state. `ended` reviews; `reviewed` is terminal.
export const REMOTE_SESSION_TRANSITIONS: Record<
  RemoteSessionStatus,
  readonly RemoteSessionStatus[]
> = {
  requested: ['awaiting_consent', 'ended'],
  awaiting_consent: ['connecting', 'ended'],
  connecting: ['active', 'ended'],
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
  ended: ['reviewed'],
  reviewed: []
}

/** True when `to` is a legal successor of `from` in the doc 07 state machine. */
export function isLegalRemoteSessionTransition(
  from: RemoteSessionStatus,
  to: RemoteSessionStatus
): boolean {
  return REMOTE_SESSION_TRANSITIONS[from]?.includes(to) ?? false
}

export type RemoteSessionParticipant = {
  id: string
  userId: string
  grade: ParticipantGrade
  isDriver: boolean
  joinedAt: string
  leftAt: string | null
}

export type RemoteSessionConsentState = {
  id: string
  subjectUserId: string
  scope: string
  grantedAt: string
  revokedAt: string | null
}

export type RemoteSession = {
  id: string
  organizationId: string
  kind: RemoteSessionKind
  status: RemoteSessionStatus
  hostUserId: string
  createdBy: string
  ticketId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type RemoteSessionDetail = RemoteSession & {
  participants: RemoteSessionParticipant[]
  latestConsent: RemoteSessionConsentState | null
}

// Shared audit event vocabulary for the support.remote_session_audit stream. Capability events
// (slice A2) ride the same stream, so they are part of the union — the audit writer is reused by
// the capability store rather than forked.
export type RemoteSessionAuditEventType =
  | 'session_created'
  | 'state_changed'
  | 'participant_joined'
  | 'participant_left'
  | 'grade_changed'
  | 'driver_changed'
  | 'consent_granted'
  | 'consent_revoked'
  | 'capability_issued'
  | 'capability_consumed'
  | 'capability_revoked'

function mapSession(row: {
  id: string
  organization_id: string
  kind: string
  status: string
  host_user_id: string
  created_by: string
  ticket_id: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}): RemoteSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind as RemoteSessionKind,
    status: row.status as RemoteSessionStatus,
    hostUserId: row.host_user_id,
    createdBy: row.created_by,
    ticketId: row.ticket_id,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

// A session lifecycle change rides the SAME outbox the delivery/chat verticals use — the
// resourceType union was extended, so no new transport code (doc 34: additive path only).
async function emitRemoteSessionChange(
  trx: Transaction<Database>,
  organizationId: string,
  sessionId: string,
  version: number,
  changeKind: 'created' | 'updated'
): Promise<void> {
  const outboxId = randomUUID()
  const occurredAt = new Date().toISOString()
  const cloudEvent = buildResourceChangeCloudEvent({
    organizationId,
    eventId: outboxId,
    resourceType: 'remote_session',
    resourceId: sessionId,
    changeKind,
    version,
    occurredAt
  })
  await trx
    .insertInto('operations.outbox_events')
    .values({
      id: outboxId,
      organization_id: organizationId,
      aggregate_type: 'remote_session',
      aggregate_id: sessionId,
      aggregate_version: version,
      event_type: cloudEvent.type,
      event_schema_version: 1,
      payload: JSON.stringify(cloudEvent),
      occurred_at: occurredAt,
      available_at: occurredAt
    })
    .execute()
}

// Best-effort audit row (FK-free table). Written INSIDE the mutation tx but, because the
// table has no session FK, it can never fail on a session-shape constraint. Exported so the
// capability store (slice A2) writes capability_* events through the SAME writer.
export async function writeRemoteSessionAudit(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    sessionId: string
    eventType: RemoteSessionAuditEventType
    actorUserId: string | null
    detail: Record<string, unknown>
  }
): Promise<void> {
  await trx
    .insertInto('support.remote_session_audit')
    .values({
      organization_id: input.organizationId,
      session_id: input.sessionId,
      event_type: input.eventType,
      actor_user_id: input.actorUserId,
      detail: JSON.stringify(input.detail)
    })
    .execute()
}

// Is the actor allowed to administer the roster / lifecycle of this session? The host or any
// active `admin` participant (doc 07: 관리자 manages participants, 조작권, 종료). This is the
// roster-authority gate; the HTTP layer separately enforces the remote.* RBAC permission.
export async function isRemoteSessionAdminTx(
  trx: Transaction<Database>,
  sessionId: string,
  actorUserId: string,
  hostUserId: string
): Promise<boolean> {
  if (actorUserId === hostUserId) {
    return true
  }
  const row = await trx
    .selectFrom('support.remote_session_participants')
    .select('id')
    .where('session_id', '=', sessionId)
    .where('user_id', '=', actorUserId)
    .where('grade', '=', 'admin')
    .where('left_at', 'is', null)
    .executeTakeFirst()
  return row !== undefined
}

export async function loadRemoteSessionTx(
  trx: Transaction<Database>,
  sessionId: string
): Promise<RemoteSession | null> {
  const row = await trx
    .selectFrom('support.remote_sessions')
    .selectAll()
    .where('id', '=', sessionId)
    .executeTakeFirst()
  return row ? mapSession(row) : null
}

async function activeConsentCountTx(
  trx: Transaction<Database>,
  sessionId: string
): Promise<number> {
  const { count } = await trx
    .selectFrom('support.remote_session_consents')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('session_id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .executeTakeFirstOrThrow()
  return Number(count)
}

/**
 * Creates a session in status='requested', adds the creator as an `admin` participant
 * (they administer the roster and lifecycle), and writes a session_created audit row —
 * all in one tenant tx. Emits a remote_session `created` invalidation.
 */
export async function createRemoteSession(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    kind: RemoteSessionKind
    hostUserId: string
    ticketId?: string | null
  }
): Promise<RemoteSession> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const inserted = await trx
      .insertInto('support.remote_sessions')
      .values({
        organization_id: input.organizationId,
        kind: input.kind,
        status: 'requested',
        host_user_id: input.hostUserId,
        created_by: input.actorUserId,
        ticket_id: input.ticketId ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const session = mapSession(inserted)
    await trx
      .insertInto('support.remote_session_participants')
      .values({
        organization_id: input.organizationId,
        session_id: session.id,
        user_id: input.actorUserId,
        grade: 'admin',
        is_driver: false
      })
      .execute()
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      eventType: 'session_created',
      actorUserId: input.actorUserId,
      detail: { kind: input.kind, hostUserId: input.hostUserId }
    })
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      eventType: 'participant_joined',
      actorUserId: input.actorUserId,
      detail: { userId: input.actorUserId, grade: 'admin' }
    })
    await emitRemoteSessionChange(trx, input.organizationId, session.id, session.version, 'created')
    return session
  })
}

export type TransitionResult =
  | { ok: true; session: RemoteSession }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: RemoteSessionStatus }
  | { ok: false; reason: 'consent_required' }

// Advances the session, bumping version, auditing state_changed, and emitting an update. When
// `expectedVersion` is provided the caller supplied If-Match → OCC is enforced; internal
// callers (consent revoke) omit it to force the safe-state transition. Moving INTO 'connecting'
// requires an active (non-revoked) consent — doc 07 ties 연결중 to 고객 동의.
async function applyTransition(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    session: RemoteSession
    actorUserId: string
    toStatus: RemoteSessionStatus
    expectedVersion?: number
    auditDetail?: Record<string, unknown>
  }
): Promise<TransitionResult> {
  const { session } = input
  if (input.expectedVersion !== undefined && session.version !== input.expectedVersion) {
    return { ok: false, reason: 'version_conflict', currentVersion: session.version }
  }
  if (!isLegalRemoteSessionTransition(session.status, input.toStatus)) {
    return { ok: false, reason: 'illegal_transition', from: session.status }
  }
  if (input.toStatus === 'connecting' && (await activeConsentCountTx(trx, session.id)) === 0) {
    return { ok: false, reason: 'consent_required' }
  }
  const newVersion = session.version + 1
  const updated = await trx
    .updateTable('support.remote_sessions')
    .set({ status: input.toStatus, version: newVersion, updated_at: new Date() })
    .where('id', '=', session.id)
    .where('version', '=', String(session.version))
    .returningAll()
    .executeTakeFirst()
  if (!updated) {
    // Lost the OCC race between our read and write.
    return { ok: false, reason: 'version_conflict', currentVersion: session.version }
  }
  await writeRemoteSessionAudit(trx, {
    organizationId: input.organizationId,
    sessionId: session.id,
    eventType: 'state_changed',
    actorUserId: input.actorUserId,
    detail: { from: session.status, to: input.toStatus, ...input.auditDetail }
  })
  // doc 34 §보안 제약 #7: ending a session (the emergency stop reached by BOTH an explicit
  // transition and consent revocation) must invalidate every live capability. This is the single
  // choke point every `ended` transition flows through, so revoking here — inside the same tx —
  // covers both paths without a second code path.
  if (input.toStatus === 'ended') {
    await revokeCapabilitiesForSessionTx(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      reason: 'session_ended',
      now: new Date()
    })
  }
  await emitRemoteSessionChange(trx, input.organizationId, session.id, newVersion, 'updated')
  return { ok: true, session: mapSession(updated) }
}

/**
 * Transitions a session with OCC (`expectedVersion` from If-Match). Enforces the doc 07 legal
 * state machine; an illegal jump, a stale version, or a missing consent for 연결중 each return a
 * typed reason. Only the host or an admin participant may drive the lifecycle.
 */
export async function transitionRemoteSession(
  db: Kysely<Database>,
  input: {
    organizationId: string
    sessionId: string
    actorUserId: string
    toStatus: RemoteSessionStatus
    expectedVersion: number
  }
): Promise<TransitionResult | { ok: false; reason: 'forbidden' }> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await loadRemoteSessionTx(trx, input.sessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    if (!(await isRemoteSessionAdminTx(trx, session.id, input.actorUserId, session.hostUserId))) {
      return { ok: false, reason: 'forbidden' }
    }
    return applyTransition(trx, {
      organizationId: input.organizationId,
      session,
      actorUserId: input.actorUserId,
      toStatus: input.toStatus,
      expectedVersion: input.expectedVersion
    })
  })
}

export type JoinParticipantResult =
  | { ok: true; participant: RemoteSessionParticipant }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'terminal' | 'already_joined' }

/**
 * Adds a participant to the roster (doc 07). Only the host or an admin participant may add
 * others. A terminal session (ended/reviewed) accepts no new participants. Audits
 * participant_joined.
 */
export async function joinParticipant(
  db: Kysely<Database>,
  input: {
    organizationId: string
    sessionId: string
    actorUserId: string
    userId: string
    grade: ParticipantGrade
  }
): Promise<JoinParticipantResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await loadRemoteSessionTx(trx, input.sessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    if (!(await isRemoteSessionAdminTx(trx, session.id, input.actorUserId, session.hostUserId))) {
      return { ok: false, reason: 'forbidden' }
    }
    if (session.status === 'ended' || session.status === 'reviewed') {
      return { ok: false, reason: 'terminal' }
    }
    const existing = await trx
      .selectFrom('support.remote_session_participants')
      .select('id')
      .where('session_id', '=', session.id)
      .where('user_id', '=', input.userId)
      .where('left_at', 'is', null)
      .executeTakeFirst()
    if (existing) {
      return { ok: false, reason: 'already_joined' }
    }
    const inserted = await trx
      .insertInto('support.remote_session_participants')
      .values({
        organization_id: input.organizationId,
        session_id: session.id,
        user_id: input.userId,
        grade: input.grade,
        is_driver: false
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      eventType: 'participant_joined',
      actorUserId: input.actorUserId,
      detail: { userId: input.userId, grade: input.grade }
    })
    await emitRemoteSessionChange(trx, input.organizationId, session.id, session.version, 'updated')
    return { ok: true, participant: mapParticipant(inserted) }
  })
}

export type UpdateGradeResult =
  | { ok: true; participant: RemoteSessionParticipant }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'participant_not_found' }

/**
 * Revokes/changes a participant's grade mid-session (doc 07: 권한은 세션 중에도 회수할 수 있다).
 * Host/admin only. Audits grade_changed with the old and new grade.
 */
export async function updateParticipantGrade(
  db: Kysely<Database>,
  input: {
    organizationId: string
    sessionId: string
    actorUserId: string
    participantId: string
    grade: ParticipantGrade
  }
): Promise<UpdateGradeResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await loadRemoteSessionTx(trx, input.sessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    if (!(await isRemoteSessionAdminTx(trx, session.id, input.actorUserId, session.hostUserId))) {
      return { ok: false, reason: 'forbidden' }
    }
    const current = await trx
      .selectFrom('support.remote_session_participants')
      .selectAll()
      .where('id', '=', input.participantId)
      .where('session_id', '=', session.id)
      .where('left_at', 'is', null)
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'participant_not_found' }
    }
    const updated = await trx
      .updateTable('support.remote_session_participants')
      .set({ grade: input.grade })
      .where('id', '=', input.participantId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      eventType: 'grade_changed',
      actorUserId: input.actorUserId,
      detail: { participantId: input.participantId, from: current.grade, to: input.grade }
    })
    await emitRemoteSessionChange(trx, input.organizationId, session.id, session.version, 'updated')
    return { ok: true, participant: mapParticipant(updated) }
  })
}

export type LeaveParticipantResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'participant_not_found' }

/**
 * Marks a participant as left (sets left_at). A participant may remove themselves; the host or an
 * admin may remove anyone. Audits participant_left. Idempotent-safe: an already-left row is a
 * participant_not_found (the active-roster filter excludes it).
 */
export async function leaveParticipant(
  db: Kysely<Database>,
  input: {
    organizationId: string
    sessionId: string
    actorUserId: string
    participantId: string
  }
): Promise<LeaveParticipantResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await loadRemoteSessionTx(trx, input.sessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    const current = await trx
      .selectFrom('support.remote_session_participants')
      .selectAll()
      .where('id', '=', input.participantId)
      .where('session_id', '=', session.id)
      .where('left_at', 'is', null)
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'participant_not_found' }
    }
    // Self-leave is always allowed; removing another requires host/admin authority.
    const isSelf = current.user_id === input.actorUserId
    if (
      !isSelf &&
      !(await isRemoteSessionAdminTx(trx, session.id, input.actorUserId, session.hostUserId))
    ) {
      return { ok: false, reason: 'forbidden' }
    }
    await trx
      .updateTable('support.remote_session_participants')
      .set({ left_at: new Date(), is_driver: false })
      .where('id', '=', input.participantId)
      .execute()
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      eventType: 'participant_left',
      actorUserId: input.actorUserId,
      detail: { participantId: input.participantId, userId: current.user_id }
    })
    await emitRemoteSessionChange(trx, input.organizationId, session.id, session.version, 'updated')
    return { ok: true }
  })
}

export type GrantConsentResult =
  | { ok: true; consent: RemoteSessionConsentState }
  | { ok: false; reason: 'not_found' | 'terminal' }

/**
 * The subject records consent (doc 07 고객 동의). Consent is what unlocks the move into 연결중
 * (enforced in applyTransition). Audits consent_granted.
 */
export async function grantConsent(
  db: Kysely<Database>,
  input: {
    organizationId: string
    sessionId: string
    subjectUserId: string
    scope?: string
  }
): Promise<GrantConsentResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await loadRemoteSessionTx(trx, input.sessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    if (session.status === 'ended' || session.status === 'reviewed') {
      return { ok: false, reason: 'terminal' }
    }
    const inserted = await trx
      .insertInto('support.remote_session_consents')
      .values({
        organization_id: input.organizationId,
        session_id: session.id,
        subject_user_id: input.subjectUserId,
        scope: input.scope ?? 'session'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      eventType: 'consent_granted',
      actorUserId: input.subjectUserId,
      detail: { scope: inserted.scope }
    })
    await emitRemoteSessionChange(trx, input.organizationId, session.id, session.version, 'updated')
    return { ok: true, consent: mapConsent(inserted) }
  })
}

export type RevokeConsentResult =
  | { ok: true; endedSession: boolean }
  | { ok: false; reason: 'not_found' | 'no_active_consent' }

/**
 * The subject withdraws consent (doc 07: 동의 철회 시 입력 즉시 차단, 연결 종료). This records the
 * revocation (never a hard delete) AND forces the session to the safe terminal state `ended` if
 * it is not already terminal — the A1 effect of a revoke, since there are no capability tokens to
 * invalidate yet (that is slice A2). Both facts are audited.
 */
export async function revokeConsent(
  db: Kysely<Database>,
  input: {
    organizationId: string
    sessionId: string
    subjectUserId: string
  }
): Promise<RevokeConsentResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await loadRemoteSessionTx(trx, input.sessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    const revoked = await trx
      .updateTable('support.remote_session_consents')
      .set({ revoked_at: new Date() })
      .where('session_id', '=', session.id)
      .where('subject_user_id', '=', input.subjectUserId)
      .where('revoked_at', 'is', null)
      .returning('id')
      .execute()
    if (revoked.length === 0) {
      return { ok: false, reason: 'no_active_consent' }
    }
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      eventType: 'consent_revoked',
      actorUserId: input.subjectUserId,
      detail: { revokedConsentCount: revoked.length }
    })
    // Force the session to a safe state. `ended` is reachable from every non-terminal state.
    let endedSession = false
    if (session.status !== 'ended' && session.status !== 'reviewed') {
      const result = await applyTransition(trx, {
        organizationId: input.organizationId,
        session,
        actorUserId: input.subjectUserId,
        toStatus: 'ended',
        auditDetail: { cause: 'consent_revoked' }
      })
      endedSession = result.ok
    } else {
      await emitRemoteSessionChange(
        trx,
        input.organizationId,
        session.id,
        session.version,
        'updated'
      )
    }
    return { ok: true, endedSession }
  })
}

/** Reads one session with its active roster and the latest consent state (org-scoped). */
export async function getRemoteSession(
  db: Kysely<Database>,
  organizationId: string,
  sessionId: string
): Promise<RemoteSessionDetail | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const session = await loadRemoteSessionTx(trx, sessionId)
    if (!session) {
      return null
    }
    const participantRows = await trx
      .selectFrom('support.remote_session_participants')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('left_at', 'is', null)
      .orderBy('joined_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    const consentRow = await trx
      .selectFrom('support.remote_session_consents')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('granted_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst()
    return {
      ...session,
      participants: participantRows.map(mapParticipant),
      latestConsent: consentRow ? mapConsent(consentRow) : null
    }
  })
}

/** Lists an org's sessions, most-recent first (org-scoped, member-visible read). */
export async function listRemoteSessions(
  db: Kysely<Database>,
  organizationId: string,
  options: { limit?: number } = {}
): Promise<RemoteSession[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('support.remote_sessions')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute()
    return rows.map(mapSession)
  })
}

function mapParticipant(row: {
  id: string
  user_id: string
  grade: string
  is_driver: boolean
  joined_at: Date | string
  left_at: Date | string | null
}): RemoteSessionParticipant {
  return {
    id: row.id,
    userId: row.user_id,
    grade: row.grade as ParticipantGrade,
    isDriver: row.is_driver,
    joinedAt: new Date(row.joined_at).toISOString(),
    leftAt: row.left_at ? new Date(row.left_at).toISOString() : null
  }
}

function mapConsent(row: {
  id: string
  subject_user_id: string
  scope: string
  granted_at: Date | string
  revoked_at: Date | string | null
}): RemoteSessionConsentState {
  return {
    id: row.id,
    subjectUserId: row.subject_user_id,
    scope: row.scope,
    grantedAt: new Date(row.granted_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null
  }
}
