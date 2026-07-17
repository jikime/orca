import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { emitCollaborationChange } from './channel-store'
import { withTenantTransaction } from './tenant-transaction'

// Sentinel body a tombstone / redacted revision carries. v1 conservative body-retention
// (doc 33:52): the body is dropped on delete while the audit row survives.
const REDACTED_BODY = ''

export type EditMessageResult =
  | { ok: true; newVersion: number }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'gone' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

/**
 * Edits a message under optimistic concurrency (doc 33 §1). AUTHOR-ONLY — a moderator
 * may delete but never edit. Immutable revision history: the ORIGINAL body is snapshotted
 * on the first edit as revision == its live version (so it is never lost), and every new
 * body is appended as a revision == the version it becomes. The invariant: for every
 * committed version N there is a message_revisions row keyed by N holding that body, so
 * any past body is reconstructable and messages.body always equals the highest revision.
 */
export async function editMessage(
  db: Kysely<Database>,
  input: {
    organizationId: string
    channelId: string
    messageId: string
    actorUserId: string
    newBody: string
    expectedVersion: number
  }
): Promise<EditMessageResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('collaboration.messages')
      .select(['id', 'channel_id', 'author_user_id', 'body', 'version', 'deleted_at'])
      .where('id', '=', input.messageId)
      .where('channel_id', '=', input.channelId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    // A tombstone is terminal — its body is redacted and must not be resurrected.
    if (current.deleted_at !== null) {
      return { ok: false, reason: 'gone' }
    }
    if (current.author_user_id !== input.actorUserId) {
      return { ok: false, reason: 'forbidden' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const newVersion = currentVersion + 1
    // First edit: preserve the pre-edit body as a revision keyed by its live version, so
    // the original survives. Later edits already have their prior body persisted as the
    // previous edit's revision, so we never re-snapshot (the forUpdate lock serializes).
    const existingRevision = await trx
      .selectFrom('collaboration.message_revisions')
      .select('id')
      .where('message_id', '=', input.messageId)
      .where('revision', '=', String(currentVersion))
      .executeTakeFirst()
    if (!existingRevision) {
      await trx
        .insertInto('collaboration.message_revisions')
        .values({
          organization_id: input.organizationId,
          message_id: input.messageId,
          revision: currentVersion,
          body: current.body,
          edited_by: current.author_user_id
        })
        .execute()
    }
    await trx
      .updateTable('collaboration.messages')
      .set({ body: input.newBody, version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.messageId)
      .execute()
    await trx
      .insertInto('collaboration.message_revisions')
      .values({
        organization_id: input.organizationId,
        message_id: input.messageId,
        revision: newVersion,
        body: input.newBody,
        edited_by: input.actorUserId
      })
      .execute()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'message.updated',
        target_type: 'message',
        target_id: input.messageId
      })
      .execute()
    await emitCollaborationChange(
      trx,
      input.organizationId,
      'message',
      input.messageId,
      newVersion,
      'updated'
    )
    return { ok: true, newVersion }
  })
}

export type DeleteMessageResult =
  | { ok: true; alreadyDeleted: boolean }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'moderator_reason_required' }

/**
 * Soft-deletes a message into a tombstone (doc 33 §2). Author OR moderator (the ROUTE
 * decides moderator-ness via a channel.manage grant; the store enforces author-or-mod).
 * A moderator deleting SOMEONE ELSE's message must supply a reason (audit); self-deletion
 * may omit it. The row, its reactions and its thread pointer are kept (thread integrity);
 * only the body — on the message AND on every revision — is redacted, while the who/when/
 * why audit metadata is retained. Re-deleting a tombstone is an idempotent no-op.
 */
export async function deleteMessage(
  db: Kysely<Database>,
  input: {
    organizationId: string
    channelId: string
    messageId: string
    actorUserId: string
    isModerator: boolean
    reason?: string
  }
): Promise<DeleteMessageResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('collaboration.messages')
      .select(['id', 'channel_id', 'author_user_id', 'version', 'deleted_at'])
      .where('id', '=', input.messageId)
      .where('channel_id', '=', input.channelId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    // Idempotent: the tombstone already exists, nothing to redact or re-emit.
    if (current.deleted_at !== null) {
      return { ok: true, alreadyDeleted: true }
    }
    const isAuthor = current.author_user_id === input.actorUserId
    if (!isAuthor && !input.isModerator) {
      return { ok: false, reason: 'forbidden' }
    }
    const reason = input.reason?.trim() ? input.reason.trim() : null
    // A moderator acting on another user's message must record why (doc 33:53).
    if (input.isModerator && !isAuthor && !reason) {
      return { ok: false, reason: 'moderator_reason_required' }
    }
    const newVersion = Number(current.version) + 1
    await trx
      .updateTable('collaboration.messages')
      .set({
        deleted_at: sql`now()`,
        deleted_by: input.actorUserId,
        deletion_reason: reason,
        body: REDACTED_BODY,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.messageId)
      .execute()
    // v1 conservative: redact stored edit-history bodies too — audit rows (revision,
    // edited_by, created_at) remain, bodies gone.
    await trx
      .updateTable('collaboration.message_revisions')
      .set({ body: REDACTED_BODY })
      .where('message_id', '=', input.messageId)
      .execute()
    // A tombstone must not stay pinned (doc 33 §3): dropping the pins here mirrors the
    // pin store's refusal to pin a tombstone. The message_pins → messages FK cascade only
    // covers a HARD row delete (e.g. channel deletion); a soft delete needs this explicit
    // cleanup so a pinned message disappears from the pin list when moderated away.
    await trx
      .deleteFrom('collaboration.message_pins')
      .where('message_id', '=', input.messageId)
      .execute()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'message.deleted',
        target_type: 'message',
        target_id: input.messageId
      })
      .execute()
    await emitCollaborationChange(
      trx,
      input.organizationId,
      'message',
      input.messageId,
      newVersion,
      'updated'
    )
    return { ok: true, alreadyDeleted: false }
  })
}
