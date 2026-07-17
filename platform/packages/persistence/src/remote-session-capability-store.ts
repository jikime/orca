import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
// Reuse A1's authority check + audit writer + session loader — the capability lifecycle is NOT a
// second source of truth; it defers to the SAME host/admin authority and the SAME audit stream.
import {
  isRemoteSessionAdminTx,
  loadRemoteSessionTx,
  writeRemoteSessionAudit
} from './remote-session-store'
import { withTenantTransaction } from './tenant-transaction'

// R8 slice A2: scoped short-lived capability tokens (doc 34 §데이터모델 CapabilityToken, §보안 제약
// #3 scoped/audience/expiry/nonce · #4 control = step-up MFA · #7 consent-revoke/policy-expiry must
// invalidate). A capability grants ONE action in ONE session, bound to ONE participant — never a
// whole-session token. This store owns issuance + redemption AUTHORITY; the Relay/host redemption
// transport (crypto, streaming) is a LATER phase and is NOT built here.

export type CapabilityKind = 'view' | 'terminal_control' | 'desktop_control' | 'file_transfer'

// doc 34 §보안 제약 #4: a control action (terminal/desktop/file) requires step-up MFA; `view` does
// not. This drives the requires_step_up enforcement at issue time.
const CONTROL_CAPABILITIES = new Set<CapabilityKind>([
  'terminal_control',
  'desktop_control',
  'file_transfer'
])

// A capability is short-lived (doc 34 §보안 제약 #3). We CLAMP (not reject) an over-long ttl down to
// this ceiling so a caller can never mint a long-lived grant, while a reasonable request still
// succeeds. Sub-second / non-finite ttls floor to 1s.
const MAX_TTL_SECONDS = 300
const DEFAULT_TTL_SECONDS = 120

function clampTtlSeconds(ttlSeconds: number | undefined): number {
  const requested = ttlSeconds ?? DEFAULT_TTL_SECONDS
  if (!Number.isFinite(requested) || requested < 1) {
    return 1
  }
  return Math.min(Math.floor(requested), MAX_TTL_SECONDS)
}

// The issued token as returned to the issuer. `nonce` is the single-use secret the redeemer must
// present — the ONLY secret material returned, and only to the caller who just minted it.
export type IssuedCapability = {
  id: string
  sessionId: string
  participantId: string
  capability: CapabilityKind
  audience: string
  nonce: string
  expiresAt: string
  requiresStepUp: boolean
}

export type IssueCapabilityResult =
  | { ok: true; capability: IssuedCapability }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'forbidden'
        | 'session_terminal'
        | 'participant_not_found'
        | 'step_up_required'
    }

/**
 * Issues a scoped short-lived single-use capability (doc 34 §보안 제약 #3). In one tenant tx it
 * asserts: the session is not terminal (ended/reviewed → `session_terminal`); the actor is the host
 * or an admin participant (A1 authority) else `forbidden`; the target participant exists and has not
 * left else `participant_not_found`; and a CONTROL capability carries requires_step_up=true (doc 34
 * §보안 제약 #4) else `step_up_required` (a `view` capability may be false). The ttl is clamped to a
 * short ceiling. `now`/`newNonce` are injected so the store is pure and deterministic under test.
 */
export async function issueCapability(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    sessionId: string
    participantId: string
    capability: CapabilityKind
    audience: string
    ttlSeconds?: number
    requiresStepUp?: boolean
    now: Date
    newNonce: string
  }
): Promise<IssueCapabilityResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await loadRemoteSessionTx(trx, input.sessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    if (session.status === 'ended' || session.status === 'reviewed') {
      return { ok: false, reason: 'session_terminal' }
    }
    if (!(await isRemoteSessionAdminTx(trx, session.id, input.actorUserId, session.hostUserId))) {
      return { ok: false, reason: 'forbidden' }
    }
    const participant = await trx
      .selectFrom('support.remote_session_participants')
      .select(['id', 'left_at'])
      .where('id', '=', input.participantId)
      .where('session_id', '=', session.id)
      .executeTakeFirst()
    if (!participant || participant.left_at !== null) {
      return { ok: false, reason: 'participant_not_found' }
    }
    const requiresStepUp = input.requiresStepUp ?? false
    if (CONTROL_CAPABILITIES.has(input.capability) && !requiresStepUp) {
      return { ok: false, reason: 'step_up_required' }
    }
    const expiresAt = new Date(input.now.getTime() + clampTtlSeconds(input.ttlSeconds) * 1000)
    const inserted = await trx
      .insertInto('support.remote_session_capabilities')
      .values({
        organization_id: input.organizationId,
        session_id: session.id,
        participant_id: input.participantId,
        capability: input.capability,
        audience: input.audience,
        nonce: input.newNonce,
        expires_at: expiresAt,
        requires_step_up: requiresStepUp,
        issued_by: input.actorUserId,
        created_at: input.now
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: session.id,
      eventType: 'capability_issued',
      actorUserId: input.actorUserId,
      // Never audit the nonce (the secret) — id + shape are enough to trace issuance.
      detail: {
        capabilityId: inserted.id,
        participantId: input.participantId,
        capability: input.capability,
        audience: input.audience,
        requiresStepUp,
        expiresAt: expiresAt.toISOString()
      }
    })
    return {
      ok: true,
      capability: {
        id: inserted.id,
        sessionId: session.id,
        participantId: input.participantId,
        capability: input.capability,
        audience: input.audience,
        nonce: input.newNonce,
        expiresAt: expiresAt.toISOString(),
        requiresStepUp
      }
    }
  })
}

/**
 * Re-reads a just-issued capability (incl. nonce) by id — used ONLY to replay an idempotent issue
 * to the SAME caller who already minted it (the Idempotency-Key already proved the match). Not an
 * HTTP endpoint; the nonce is returned solely to reconstruct the identical 201 body.
 */
export async function getIssuedCapability(
  db: Kysely<Database>,
  organizationId: string,
  sessionId: string,
  capabilityId: string
): Promise<IssuedCapability | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('support.remote_session_capabilities')
      .selectAll()
      .where('id', '=', capabilityId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst()
    if (!row) {
      return null
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      participantId: row.participant_id,
      capability: row.capability as CapabilityKind,
      audience: row.audience,
      nonce: row.nonce,
      expiresAt: new Date(row.expires_at).toISOString(),
      requiresStepUp: row.requires_step_up
    }
  })
}

// The action a redeemed capability grants. Deliberately minimal — no nonce, no audience echo.
export type CapabilityGrant = {
  capability: CapabilityKind
  participantId: string
}

export type RedeemCapabilityResult =
  | { ok: true; grant: CapabilityGrant }
  | {
      ok: false
      reason: 'invalid' | 'already_consumed' | 'revoked' | 'expired' | 'audience_mismatch'
    }

/**
 * Redeems a capability by (session, nonce) — the check a host/Relay performs before honoring a
 * grant. Single-use: on success it stamps consumed_at, audits capability_consumed, and returns the
 * granted action; a second redemption of the same nonce → `already_consumed`. State checks run in a
 * fixed order (found → consumed → revoked → expired → audience) so each failure maps to a precise
 * code. `now` is injected for deterministic expiry evaluation.
 */
export async function redeemCapability(
  db: Kysely<Database>,
  input: {
    organizationId: string
    sessionId: string
    nonce: string
    audience: string
    now: Date
  }
): Promise<RedeemCapabilityResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .selectFrom('support.remote_session_capabilities')
      .selectAll()
      .where('session_id', '=', input.sessionId)
      .where('nonce', '=', input.nonce)
      .executeTakeFirst()
    if (!row) {
      return { ok: false, reason: 'invalid' }
    }
    if (row.consumed_at !== null) {
      return { ok: false, reason: 'already_consumed' }
    }
    if (row.revoked_at !== null) {
      return { ok: false, reason: 'revoked' }
    }
    if (new Date(row.expires_at).getTime() <= input.now.getTime()) {
      return { ok: false, reason: 'expired' }
    }
    if (row.audience !== input.audience) {
      return { ok: false, reason: 'audience_mismatch' }
    }
    await trx
      .updateTable('support.remote_session_capabilities')
      .set({ consumed_at: input.now })
      .where('id', '=', row.id)
      .where('consumed_at', 'is', null)
      .execute()
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      eventType: 'capability_consumed',
      actorUserId: row.issued_by,
      detail: {
        capabilityId: row.id,
        capability: row.capability,
        participantId: row.participant_id
      }
    })
    return {
      ok: true,
      grant: { capability: row.capability as CapabilityKind, participantId: row.participant_id }
    }
  })
}

/**
 * Revokes every OUTSTANDING capability (not consumed, not revoked) of a session, stamping revoked_at
 * and auditing capability_revoked per row. Takes a live Transaction so A1 can invoke it INSIDE the
 * consent-revoke / ended transition (doc 34 §보안 제약 #7 — one tx, no orphan). `now` is injected.
 */
export async function revokeCapabilitiesForSessionTx(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    sessionId: string
    reason: string
    now: Date
  }
): Promise<number> {
  const revoked = await trx
    .updateTable('support.remote_session_capabilities')
    .set({ revoked_at: input.now })
    .where('session_id', '=', input.sessionId)
    .where('consumed_at', 'is', null)
    .where('revoked_at', 'is', null)
    .returning(['id', 'capability', 'participant_id'])
    .execute()
  for (const row of revoked) {
    await writeRemoteSessionAudit(trx, {
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      eventType: 'capability_revoked',
      actorUserId: null,
      detail: {
        capabilityId: row.id,
        capability: row.capability,
        participantId: row.participant_id,
        reason: input.reason
      }
    })
  }
  return revoked.length
}

// The lifecycle status derived from timestamps for an audit/UI listing. consumed/revoked win over
// expired (a terminal outcome is more informative than "it also aged out").
export type CapabilityStatus = 'live' | 'consumed' | 'revoked' | 'expired'

export type CapabilitySummary = {
  id: string
  participantId: string
  capability: CapabilityKind
  audience: string
  status: CapabilityStatus
  requiresStepUp: boolean
  issuedBy: string
  expiresAt: string
  createdAt: string
  consumedAt: string | null
  revokedAt: string | null
}

function deriveStatus(
  row: { consumed_at: Date | null; revoked_at: Date | null; expires_at: Date },
  now: Date
): CapabilityStatus {
  if (row.consumed_at !== null) {
    return 'consumed'
  }
  if (row.revoked_at !== null) {
    return 'revoked'
  }
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    return 'expired'
  }
  return 'live'
}

/**
 * Lists a session's capabilities with a derived live/consumed/revoked/expired status, for
 * audit/UI. Org-scoped; the caller (HTTP layer) resource-gates remote.view first. The nonce (the
 * secret) is NEVER exposed here — only tracing metadata. `now` is injected for deterministic status.
 */
export async function listSessionCapabilities(
  db: Kysely<Database>,
  organizationId: string,
  sessionId: string,
  now: Date
): Promise<CapabilitySummary[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('support.remote_session_capabilities')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      participantId: row.participant_id,
      capability: row.capability as CapabilityKind,
      audience: row.audience,
      status: deriveStatus(row, now),
      requiresStepUp: row.requires_step_up,
      issuedBy: row.issued_by,
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null
    }))
  })
}
