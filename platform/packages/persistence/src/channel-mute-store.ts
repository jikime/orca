import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import { isChannelMemberTx } from './channel-store'
import { withTenantTransaction } from './tenant-transaction'

export type ChannelMuteResult =
  | { ok: true }
  | { ok: false; reason: 'channel_not_found' | 'not_a_member' }

/**
 * The subset of `candidateUserIds` that have muted this channel. Used by the mention
 * resolver to filter BROADCAST (@channel/@here) targets — a muted user swept up only by
 * a broadcast gets no notification. Scoped to the given candidates so the fan-out never
 * scans the whole mute table. Runs inside the caller's message tx (org tenant context).
 */
export async function mutedUserIdsForChannelTx(
  trx: Transaction<Database>,
  channelId: string,
  candidateUserIds: readonly string[]
): Promise<Set<string>> {
  if (candidateUserIds.length === 0) {
    return new Set()
  }
  const rows = await trx
    .selectFrom('collaboration.channel_mutes')
    .select('user_id')
    .where('channel_id', '=', channelId)
    .where('user_id', 'in', [...candidateUserIds])
    .execute()
  return new Set(rows.map((row) => row.user_id))
}

/**
 * Mutes a channel for one user (idempotent — a repeat PUT is a no-op via the PK
 * conflict). Member-gated inside the tx: only a member of a channel that exists may mute
 * it (404 channel_not_found vs 403 not_a_member is a membership question, not existence).
 */
export async function muteChannel(
  db: Kysely<Database>,
  input: { organizationId: string; channelId: string; userId: string }
): Promise<ChannelMuteResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const channel = await trx
      .selectFrom('collaboration.channels')
      .select('id')
      .where('id', '=', input.channelId)
      .executeTakeFirst()
    if (!channel) {
      return { ok: false, reason: 'channel_not_found' }
    }
    if (!(await isChannelMemberTx(trx, input.channelId, input.userId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    await trx
      .insertInto('collaboration.channel_mutes')
      .values({
        organization_id: input.organizationId,
        channel_id: input.channelId,
        user_id: input.userId
      })
      .onConflict((oc) => oc.columns(['organization_id', 'channel_id', 'user_id']).doNothing())
      .execute()
    return { ok: true }
  })
}

/**
 * Unmutes a channel for one user (idempotent — deleting an absent mute is a no-op).
 * Same member-gate as muteChannel so both endpoints answer 404/403 identically.
 */
export async function unmuteChannel(
  db: Kysely<Database>,
  input: { organizationId: string; channelId: string; userId: string }
): Promise<ChannelMuteResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const channel = await trx
      .selectFrom('collaboration.channels')
      .select('id')
      .where('id', '=', input.channelId)
      .executeTakeFirst()
    if (!channel) {
      return { ok: false, reason: 'channel_not_found' }
    }
    if (!(await isChannelMemberTx(trx, input.channelId, input.userId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    await trx
      .deleteFrom('collaboration.channel_mutes')
      .where('channel_id', '=', input.channelId)
      .where('user_id', '=', input.userId)
      .execute()
    return { ok: true }
  })
}
