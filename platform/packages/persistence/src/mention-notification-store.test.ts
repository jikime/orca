import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { addChannelMember, createChannel } from './channel-store'
import { postMessage } from './message-store'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead
} from './notification-store'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withTenantTransaction } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

async function member(orgId: string, tag: string): Promise<string> {
  const { userId } = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: 'i',
    subject: `${tag}-${orgId.slice(0, 8)}`
  })
  return userId
}

async function freshChannel(): Promise<{
  orgId: string
  poster: string
  mentioned: string
  channelId: string
}> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `mn-${orgId.slice(0, 8)}`,
    displayName: 'MN'
  })
  const poster = await member(orgId, 'poster')
  const mentioned = await member(orgId, 'mentioned')
  const channel = await createChannel(db, { organizationId: orgId, actorUserId: poster, name: 'c' })
  await addChannelMember(db, { organizationId: orgId, channelId: channel.id, userId: mentioned })
  return { orgId, poster, mentioned, channelId: channel.id }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED mention/notification suite: Docker unavailable — ${String(error)}`)
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

describe('collaboration: mentions', () => {
  it('creates a mention row + notification for a member and drops non-members', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, poster, mentioned, channelId } = await freshChannel()
    const nonMember = randomUUID()
    const posted = await postMessage(db, {
      organizationId: orgId,
      channelId,
      authorUserId: poster,
      body: 'hey @mentioned and @ghost',
      mentions: [mentioned, nonMember]
    })
    expect(posted.ok).toBe(true)
    if (!posted.ok) return
    const mentions = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('collaboration.message_mentions')
        .select('mentioned_user_id')
        .where('message_id', '=', posted.message.id)
        .execute()
    )
    // Only the real member is stored; the non-member is dropped.
    expect(mentions.map((m) => m.mentioned_user_id)).toEqual([mentioned])
    const forMentioned = await listNotifications(db, orgId, mentioned)
    expect(forMentioned.items.length).toBe(1)
    expect(forMentioned.items[0]).toMatchObject({
      type: 'mention',
      messageId: posted.message.id,
      channelId,
      read: false
    })
  })
})

describe('collaboration: notification per-user isolation (security)', () => {
  it("an org peer cannot read or mark another user's notifications", async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, poster, mentioned, channelId } = await freshChannel()
    const posted = await postMessage(db, {
      organizationId: orgId,
      channelId,
      authorUserId: poster,
      body: 'ping',
      mentions: [mentioned]
    })
    if (!posted.ok) return
    const targetId = (await listNotifications(db, orgId, mentioned)).items[0]!.id
    // The poster (same org) sees NONE of the mentioned user's notifications.
    expect((await listNotifications(db, orgId, poster)).items).toEqual([])
    // The poster cannot mark the mentioned user's notification read (RLS → no row).
    expect(await markNotificationRead(db, orgId, poster, targetId)).toEqual({
      ok: false,
      reason: 'not_found'
    })
    // The owner can.
    const owned = await markNotificationRead(db, orgId, mentioned, targetId)
    expect(owned.ok && owned.notification.read).toBe(true)
  })

  it("markAll only affects the caller's own notifications", async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, poster, mentioned, channelId } = await freshChannel()
    // Mention both users so each has one unread notification.
    await postMessage(db, {
      organizationId: orgId,
      channelId,
      authorUserId: poster,
      body: 'both',
      mentions: [poster, mentioned]
    })
    const cleared = await markAllNotificationsRead(db, orgId, mentioned)
    expect(cleared).toBe(1)
    // The poster's own notification is still unread.
    const posterUnread = await listNotifications(db, orgId, poster, { unreadOnly: true })
    expect(posterUnread.items.length).toBe(1)
  })

  it('blocks cross-tenant notification reads under RLS', async (ctx) => {
    if (!harness) return ctx.skip()
    const a = await freshChannel()
    const b = await freshChannel()
    await postMessage(db, {
      organizationId: a.orgId,
      channelId: a.channelId,
      authorUserId: a.poster,
      body: 'x',
      mentions: [a.mentioned]
    })
    // Reading org A's notifications from org B's tenant context → nothing.
    const seenFromB = await withTenantTransaction(db, b.orgId, (trx) =>
      trx.selectFrom('collaboration.notifications').select('id').execute()
    )
    expect(seenFromB).toEqual([])
  })
})
