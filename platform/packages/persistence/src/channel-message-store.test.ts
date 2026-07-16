import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { addChannelMember, createChannel, getChannelForMember, listChannels } from './channel-store'
import { listChannelMessages, postMessage } from './message-store'
import { getReadCursor, markChannelRead } from './read-cursor-store'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withTenantTransaction } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

async function freshOrg(): Promise<{ orgId: string; userId: string }> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `ch-${orgId.slice(0, 8)}`,
    displayName: 'CH'
  })
  const { userId } = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: 'i',
    subject: `u-${orgId.slice(0, 8)}`
  })
  return { orgId, userId }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED channel/message suite: Docker unavailable — ${String(error)}`)
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

describe('collaboration: channel', () => {
  it('creates a channel with the creator as its first member', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId } = await freshOrg()
    const channel = await createChannel(db, {
      organizationId: orgId,
      actorUserId: userId,
      name: 'general'
    })
    const mine = await listChannels(db, orgId, userId)
    expect(mine.map((c) => c.id)).toContain(channel.id)
    const asMember = await getChannelForMember(db, orgId, channel.id, userId)
    expect(asMember.ok).toBe(true)
  })

  it('lists only channels the user is a member of', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId } = await freshOrg()
    const other = await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `other-${orgId.slice(0, 8)}`
    })
    await createChannel(db, { organizationId: orgId, actorUserId: userId, name: 'mine' })
    // A channel the other user owns; our user is not a member.
    await createChannel(db, { organizationId: orgId, actorUserId: other.userId, name: 'theirs' })
    const mine = await listChannels(db, orgId, userId)
    expect(mine.map((c) => c.name)).toEqual(['mine'])
  })

  it('blocks cross-tenant channel reads under RLS', async (ctx) => {
    if (!harness) return ctx.skip()
    const a = await freshOrg()
    const b = await freshOrg()
    const channel = await createChannel(db, {
      organizationId: a.orgId,
      actorUserId: a.userId,
      name: 'secret'
    })
    const seenFromB = await withTenantTransaction(db, b.orgId, (trx) =>
      trx.selectFrom('collaboration.channels').select('id').where('id', '=', channel.id).execute()
    )
    expect(seenFromB).toEqual([])
  })
})

describe('collaboration: message', () => {
  it('a member posts and a non-member cannot', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId } = await freshOrg()
    const stranger = await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `stranger-${orgId.slice(0, 8)}`
    })
    const channel = await createChannel(db, {
      organizationId: orgId,
      actorUserId: userId,
      name: 'c'
    })
    const ok = await postMessage(db, {
      organizationId: orgId,
      channelId: channel.id,
      authorUserId: userId,
      body: 'hi'
    })
    expect(ok.ok).toBe(true)
    const denied = await postMessage(db, {
      organizationId: orgId,
      channelId: channel.id,
      authorUserId: stranger.userId,
      body: 'intruding'
    })
    expect(denied).toEqual({ ok: false, reason: 'not_a_member' })
    // The outbox carries a message.created invalidation.
    const outbox = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('operations.outbox_events')
        .select('event_type')
        .where('aggregate_type', '=', 'message')
        .executeTakeFirst()
    )
    expect(outbox?.event_type).toContain('message.created')
  })

  it('paginates messages by message-id cursor', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId } = await freshOrg()
    const channel = await createChannel(db, {
      organizationId: orgId,
      actorUserId: userId,
      name: 'c'
    })
    for (const b of ['m1', 'm2', 'm3']) {
      await postMessage(db, {
        organizationId: orgId,
        channelId: channel.id,
        authorUserId: userId,
        body: b
      })
    }
    const page1 = await listChannelMessages(db, orgId, channel.id, userId, { limit: 2 })
    if (!page1.ok) return
    expect(page1.messages.map((m) => m.body)).toEqual(['m1', 'm2'])
    expect(page1.nextCursor).toBe(page1.messages[1]!.id)
    const page2 = await listChannelMessages(db, orgId, channel.id, userId, {
      limit: 2,
      afterMessageId: page1.nextCursor!
    })
    if (!page2.ok) return
    expect(page2.messages.map((m) => m.body)).toEqual(['m3'])
    expect(page2.nextCursor).toBe(null)
  })
})

describe('collaboration: read cursor', () => {
  it('marks read per-user and keeps cursors independent', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId } = await freshOrg()
    const second = await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'i',
      subject: `second-${orgId.slice(0, 8)}`
    })
    const channel = await createChannel(db, {
      organizationId: orgId,
      actorUserId: userId,
      name: 'c'
    })
    await addChannelMember(db, {
      organizationId: orgId,
      channelId: channel.id,
      userId: second.userId
    })
    const post = await postMessage(db, {
      organizationId: orgId,
      channelId: channel.id,
      authorUserId: userId,
      body: 'hi'
    })
    if (!post.ok) return
    const marked = await markChannelRead(db, {
      organizationId: orgId,
      channelId: channel.id,
      userId,
      lastReadMessageId: post.message.id
    })
    expect(marked.ok && marked.cursor.lastReadMessageId).toBe(post.message.id)
    // The second member's cursor is untouched.
    expect(await getReadCursor(db, orgId, channel.id, second.userId)).toBe(null)
  })

  it('rejects a cursor pointing at a message from another channel', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, userId } = await freshOrg()
    const a = await createChannel(db, { organizationId: orgId, actorUserId: userId, name: 'a' })
    const b = await createChannel(db, { organizationId: orgId, actorUserId: userId, name: 'b' })
    const postB = await postMessage(db, {
      organizationId: orgId,
      channelId: b.id,
      authorUserId: userId,
      body: 'in b'
    })
    if (!postB.ok) return
    const result = await markChannelRead(db, {
      organizationId: orgId,
      channelId: a.id,
      userId,
      lastReadMessageId: postB.message.id
    })
    expect(result).toEqual({ ok: false, reason: 'message_not_found' })
  })
})
