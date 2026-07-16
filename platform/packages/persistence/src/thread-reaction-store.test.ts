import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { addChannelMember, createChannel } from './channel-store'
import { getMessageWithReactions, listChannelMessages, postMessage } from './message-store'
import { addReaction, removeReaction } from './reaction-store'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withTenantTransaction } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

async function freshOrgChannel(): Promise<{ orgId: string; userId: string; channelId: string }> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `tr-${orgId.slice(0, 8)}`,
    displayName: 'TR'
  })
  const { userId } = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: 'i',
    subject: `u-${orgId.slice(0, 8)}`
  })
  const channel = await createChannel(db, { organizationId: orgId, actorUserId: userId, name: 'c' })
  return { orgId, userId, channelId: channel.id }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED thread/reaction suite: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
}, 180_000)

afterAll(async () => {
  await db?.destroy()
  await harness?.stop()
})

async function post(
  orgId: string,
  channelId: string,
  userId: string,
  body: string,
  threadRootMessageId?: string
) {
  return postMessage(db, {
    organizationId: orgId,
    channelId,
    authorUserId: userId,
    body,
    ...(threadRootMessageId ? { threadRootMessageId } : {})
  })
}

describe('collaboration: threads', () => {
  it('replies point at a root and the thread list returns only that thread', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId, channelId } = await freshOrgChannel()
    const root = await post(orgId, channelId, userId, 'root')
    if (!root.ok) return
    await post(orgId, channelId, userId, 'unrelated')
    const r1 = await post(orgId, channelId, userId, 'reply 1', root.message.id)
    const r2 = await post(orgId, channelId, userId, 'reply 2', root.message.id)
    expect(r1.ok && r1.message.threadRootMessageId).toBe(root.message.id)
    expect(r2.ok).toBe(true)
    const thread = await listChannelMessages(db, orgId, channelId, userId, {
      threadRootMessageId: root.message.id
    })
    if (!thread.ok) return
    expect(thread.messages.map((m) => m.body)).toEqual(['reply 1', 'reply 2'])
    // The whole-channel list shows the root's reply count.
    const all = await listChannelMessages(db, orgId, channelId, userId)
    if (!all.ok) return
    const rootInList = all.messages.find((m) => m.id === root.message.id)
    expect(rootInList?.replyCount).toBe(2)
  })

  it('rejects a reply whose root is in another channel', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId, channelId } = await freshOrgChannel()
    const otherChannel = await createChannel(db, {
      organizationId: orgId,
      actorUserId: userId,
      name: 'other'
    })
    const rootElsewhere = await post(orgId, otherChannel.id, userId, 'root elsewhere')
    if (!rootElsewhere.ok) return
    const reply = await post(orgId, channelId, userId, 'bad reply', rootElsewhere.message.id)
    expect(reply).toEqual({ ok: false, reason: 'invalid_thread_root' })
  })

  it('rejects a reply targeting a reply (threads stay flat)', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId, channelId } = await freshOrgChannel()
    const root = await post(orgId, channelId, userId, 'root')
    if (!root.ok) return
    const reply = await post(orgId, channelId, userId, 'reply', root.message.id)
    if (!reply.ok) return
    const nested = await post(orgId, channelId, userId, 'nested', reply.message.id)
    expect(nested).toEqual({ ok: false, reason: 'invalid_thread_root' })
  })
})

describe('collaboration: reactions', () => {
  it('aggregates reactions with counts and reactedByMe', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId, channelId } = await freshOrgChannel()
    const second = await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `second-${orgId.slice(0, 8)}`
    })
    await addChannelMember(db, { organizationId: orgId, channelId, userId: second.userId })
    const msg = await post(orgId, channelId, userId, 'react to me')
    if (!msg.ok) return
    const base = { organizationId: orgId, channelId, messageId: msg.message.id }
    await addReaction(db, { ...base, userId, emoji: '👍' })
    // Same user, same emoji again → still one (PK).
    await addReaction(db, { ...base, userId, emoji: '👍' })
    // A different user, same emoji → count 2.
    await addReaction(db, { ...base, userId: second.userId, emoji: '👍' })
    const forMe = await getMessageWithReactions(db, orgId, msg.message.id, userId)
    const thumbs = forMe?.reactions.find((r) => r.emoji === '👍')
    expect(thumbs).toEqual({ emoji: '👍', count: 2, reactedByMe: true })
    // The second user sees reactedByMe true as well (they reacted); a third-party lens
    // where the caller did NOT react:
    const stranger = randomUUID()
    const forStranger = await getMessageWithReactions(db, orgId, msg.message.id, stranger)
    expect(forStranger?.reactions.find((r) => r.emoji === '👍')?.reactedByMe).toBe(false)
  })

  it('removes a reaction and treats remove-again as a no-op', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId, channelId } = await freshOrgChannel()
    const msg = await post(orgId, channelId, userId, 'toggle')
    if (!msg.ok) return
    const base = { organizationId: orgId, channelId, messageId: msg.message.id, userId }
    await addReaction(db, { ...base, emoji: '🎉' })
    expect((await removeReaction(db, { ...base, emoji: '🎉' })).ok).toBe(true)
    // Removing again is still ok (no-op).
    expect((await removeReaction(db, { ...base, emoji: '🎉' })).ok).toBe(true)
    const after = await getMessageWithReactions(db, orgId, msg.message.id, userId)
    expect(after?.reactions).toEqual([])
  })

  it('blocks a non-member reaction and cross-tenant reads', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId, channelId } = await freshOrgChannel()
    const stranger = await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `stranger-${orgId.slice(0, 8)}`
    })
    const msg = await post(orgId, channelId, userId, 'guarded')
    if (!msg.ok) return
    const denied = await addReaction(db, {
      organizationId: orgId,
      channelId,
      messageId: msg.message.id,
      userId: stranger.userId,
      emoji: '👍'
    })
    expect(denied).toEqual({ ok: false, reason: 'not_a_member' })
    await addReaction(db, {
      organizationId: orgId,
      channelId,
      messageId: msg.message.id,
      userId,
      emoji: '👍'
    })
    const other = await freshOrgChannel()
    const seenFromOther = await withTenantTransaction(db, other.orgId, (trx) =>
      trx
        .selectFrom('collaboration.message_reactions')
        .select('emoji')
        .where('message_id', '=', msg.message.id)
        .execute()
    )
    expect(seenFromOther).toEqual([])
  })
})
