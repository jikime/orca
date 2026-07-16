import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { memberEntitlementDecision } from './entitlement-check'
import { buildResourceChangeCloudEvent } from './resource-change-event'
import { loadRoleManifestCatalog, type RoleManifestCatalog } from './role-manifest-catalog'
import { withoutTenantContext, withTenantTransaction } from './tenant-transaction'

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf-8').digest('hex')
}

export type CreateInvitationInput = {
  organizationId: string
  actorUserId: string
  email: string
  userType: string
  roleIds: string[]
  expiresInMs?: number
}

export type CreateInvitationResult = {
  invitationId: string
  // The RAW token — returned ONCE (delivered to the invitee via email/deep link).
  // Only its hash is persisted.
  rawToken: string
}

export class InvalidInviteRoleError extends Error {
  constructor(roleId: string) {
    super(`invitation references an unknown role: ${roleId}`)
    this.name = 'InvalidInviteRoleError'
  }
}

/**
 * Creates an invitation (admin action). Generates a high-entropy raw token, stores
 * ONLY its hash (doc 01:88), and writes the invite + audit in one org transaction.
 * The role template is validated against the manifest and FIXED on the invite —
 * the acceptor cannot choose it.
 */
export async function createInvitation(
  db: Kysely<Database>,
  input: CreateInvitationInput,
  catalog: RoleManifestCatalog = loadRoleManifestCatalog()
): Promise<CreateInvitationResult> {
  for (const roleId of input.roleIds) {
    if (!catalog.hasRole(roleId)) {
      throw new InvalidInviteRoleError(roleId)
    }
  }
  const rawToken = randomBytes(32).toString('base64url')
  const tokenHash = hashInviteToken(rawToken)
  const expiresAt = new Date(
    Date.now() + (input.expiresInMs ?? DEFAULT_INVITE_TTL_MS)
  ).toISOString()

  const invitationId = await withTenantTransaction(db, input.organizationId, async (trx) => {
    const invite = await trx
      .insertInto('identity.invitations')
      .values({
        organization_id: input.organizationId,
        email: input.email,
        user_type: input.userType,
        role_ids: input.roleIds,
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_by: input.actorUserId
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'invitation.created',
        target_type: 'invitation',
        target_id: invite.id
      })
      .execute()
    return invite.id
  })
  return { invitationId, rawToken }
}

export type RevokeInvitationResult = { outcome: 'revoked' | 'not_pending' }

/** Admin revokes a pending invite before acceptance (doc 01:93). */
export async function revokeInvitation(
  db: Kysely<Database>,
  input: { organizationId: string; invitationId: string; actorUserId: string }
): Promise<RevokeInvitationResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const updated = await trx
      .updateTable('identity.invitations')
      .set({ status: 'revoked', updated_at: sql`now()` })
      .where('id', '=', input.invitationId)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst()
    if (!updated) {
      return { outcome: 'not_pending' }
    }
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'invitation.revoked',
        target_type: 'invitation',
        target_id: input.invitationId
      })
      .execute()
    return { outcome: 'revoked' }
  })
}

export type AcceptInvitationSubject = {
  issuer: string
  subject: string
  email: string
  emailVerified: boolean
  displayName: string
}

export type AcceptInvitationResult =
  | { ok: true; organizationId: string; membershipId: string; userId: string }
  | {
      ok: false
      reason:
        | 'invalid_token'
        | 'expired'
        | 'not_pending'
        | 'email_mismatch'
        | 'email_unverified'
        // Distinct from a permission denial: the ORG is at its member limit.
        | 'entitlement_shortfall'
    }

/**
 * Accepts an invitation, consuming it single-use and creating the Membership with
 * the role/scope FIXED BY THE INVITE. Runs privileged (the acceptor is not yet a
 * member) and is authorized by possession of the token hash + the invite's target
 * email matching the verified token subject's email. A second accept of the same
 * token fails (status no longer pending) — replay defense (AUT-004). Cross-org /
 * cross-account replay is structurally impossible: the invite is bound to one org
 * and one email, and the membership it creates is the invite's, not the caller's.
 */
export async function acceptInvitation(
  db: Kysely<Database>,
  subject: AcceptInvitationSubject,
  rawToken: string
): Promise<AcceptInvitationResult> {
  if (!subject.emailVerified) {
    return { ok: false, reason: 'email_unverified' }
  }
  const tokenHash = hashInviteToken(rawToken)
  return withoutTenantContext(db, async (trx) => {
    const invite = await trx
      .selectFrom('identity.invitations')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst()
    if (!invite) {
      return { ok: false, reason: 'invalid_token' }
    }
    if (invite.status !== 'pending') {
      return { ok: false, reason: 'not_pending' }
    }
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      await trx
        .updateTable('identity.invitations')
        .set({ status: 'expired', updated_at: sql`now()` })
        .where('id', '=', invite.id)
        .execute()
      return { ok: false, reason: 'expired' }
    }
    // The invite is bound to a target email: only that identity may accept.
    if (invite.email.toLowerCase() !== subject.email.toLowerCase()) {
      return { ok: false, reason: 'email_mismatch' }
    }

    const account = await trx
      .insertInto('identity.user_accounts')
      .values({
        issuer: subject.issuer,
        subject: subject.subject,
        email: subject.email,
        email_verified: subject.emailVerified,
        display_name: subject.displayName
      })
      .onConflict((oc) =>
        oc.columns(['issuer', 'subject']).doUpdateSet({
          email: subject.email,
          email_verified: subject.emailVerified,
          updated_at: sql`now()`
        })
      )
      .returning('id')
      .executeTakeFirstOrThrow()
    const userId = account.id

    // Entitlement gate (doc 11:52 order: org entitlement BEFORE the membership is
    // created). Skip when the invitee is already an active member (no new seat).
    const alreadyActive = await trx
      .selectFrom('identity.memberships')
      .select('id')
      .where('organization_id', '=', invite.organization_id)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirst()
    if (!alreadyActive) {
      const entitlement = await memberEntitlementDecision(trx, invite.organization_id)
      if (!entitlement.allowed) {
        await trx
          .insertInto('audit.audit_events')
          .values({
            organization_id: invite.organization_id,
            actor_id: userId,
            // Distinct audit code from authz.denied.* — an entitlement shortfall.
            action: 'entitlement.shortfall.core_members',
            target_type: 'core.members',
            target_id: invite.id
          })
          .execute()
        return { ok: false, reason: 'entitlement_shortfall' }
      }
    }

    const membership = await trx
      .insertInto('identity.memberships')
      .values({
        organization_id: invite.organization_id,
        user_id: userId,
        status: 'active',
        role_ids: invite.role_ids
      })
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'user_id'])
          .doUpdateSet({ status: 'active', role_ids: invite.role_ids, updated_at: sql`now()` })
      )
      .returning('id')
      .executeTakeFirstOrThrow()

    await trx
      .updateTable('identity.invitations')
      .set({
        status: 'accepted',
        accepted_at: sql`now()`,
        accepted_by: userId,
        updated_at: sql`now()`
      })
      .where('id', '=', invite.id)
      .execute()

    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: invite.organization_id,
        actor_id: userId,
        action: 'invitation.accepted',
        target_type: 'membership',
        target_id: membership.id
      })
      .execute()

    const outboxId = randomUUID()
    const occurredAt = new Date().toISOString()
    const cloudEvent = buildResourceChangeCloudEvent({
      organizationId: invite.organization_id,
      eventId: outboxId,
      resourceType: 'membership',
      resourceId: membership.id,
      changeKind: 'created',
      version: 1,
      occurredAt
    })
    await trx
      .insertInto('operations.outbox_events')
      .values({
        id: outboxId,
        organization_id: invite.organization_id,
        aggregate_type: 'membership',
        aggregate_id: membership.id,
        aggregate_version: 1,
        event_type: cloudEvent.type,
        event_schema_version: 1,
        payload: JSON.stringify(cloudEvent),
        occurred_at: occurredAt,
        available_at: occurredAt
      })
      .execute()

    return { ok: true, organizationId: invite.organization_id, membershipId: membership.id, userId }
  })
}
