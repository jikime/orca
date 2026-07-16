import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { computeDmKey, createDm, isChannelMemberTx, listChannels } from './channel-store'
import { listChannelMessages, postMessage } from './message-store'
import { addReaction } from './reaction-store'
import { getMessageWithReactions } from './message-store'
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
    subject: `${tag}-${randomUUID().slice(0, 8)}`
  })
  return userId
}

async function freshOrg(): Promise<{ orgId: string; a: string; b: string; c: string }> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `dm-${orgId.slice(0, 8)}`,
    displayName: 'DM'
  })
  return {
    orgId,
    a: await member(orgId, 'a'),
    b: await member(orgId, 'b'),
    c: await member(orgId, 'c')
  }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED dm suite: Docker unavailable — ${String(error)}`)
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

describe('collaboration: DM find-or-create', () => {
  it('computeDmKey is order-independent', () => {
    const x = randomUUID()
    const y = randomUUID()
    expect(computeDmKey([x, y])).toBe(computeDmKey([y, x]))
  })

  it('computeDmKey is order-independent for N>2 (group DM)', () => {
    const x = randomUUID()
    const y = randomUUID()
    const z = randomUUID()
    expect(computeDmKey([x, y, z])).toBe(computeDmKey([z, x, y]))
    // A 3-party key differs from any of its 2-party subsets.
    expect(computeDmKey([x, y, z])).not.toBe(computeDmKey([x, y]))
  })

  it('createDm(A,B) and createDm(B,A) resolve to the SAME channel', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, a, b } = await freshOrg()
    const first = await createDm(db, { organizationId: orgId, actorUserId: a, otherUserId: b })
    const second = await createDm(db, { organizationId: orgId, actorUserId: b, otherUserId: a })
    if ('error' in first || 'error' in second) throw new Error('unexpected error')
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.channel.id).toBe(first.channel.id)
    expect(first.channel.kind).toBe('dm')
  })

  it('two concurrent creates resolve to ONE channel', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, a, b } = await freshOrg()
    const [r1, r2] = await Promise.all([
      createDm(db, { organizationId: orgId, actorUserId: a, otherUserId: b }),
      createDm(db, { organizationId: orgId, actorUserId: b, otherUserId: a })
    ])
    if ('error' in r1 || 'error' in r2) throw new Error('unexpected error')
    expect(r1.channel.id).toBe(r2.channel.id)
    // Exactly one dm row for this key.
    const rows = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('collaboration.channels')
        .select('id')
        .where('kind', '=', 'dm')
        .where('dm_key', '=', computeDmKey([a, b]))
        .execute()
    )
    expect(rows.length).toBe(1)
  })

  it('both participants are members; a third user is not', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, a, b, c } = await freshOrg()
    const dm = await createDm(db, { organizationId: orgId, actorUserId: a, otherUserId: b })
    if ('error' in dm) throw new Error('unexpected')
    const membership = await withTenantTransaction(db, orgId, async (trx) => ({
      a: await isChannelMemberTx(trx, dm.channel.id, a),
      b: await isChannelMemberTx(trx, dm.channel.id, b),
      c: await isChannelMemberTx(trx, dm.channel.id, c)
    }))
    expect(membership).toEqual({ a: true, b: true, c: false })
  })

  it('rejects DMing a non-org-member', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, a } = await freshOrg()
    const outsider = randomUUID()
    expect(
      await createDm(db, { organizationId: orgId, actorUserId: a, otherUserId: outsider })
    ).toEqual({
      error: 'invalid_target'
    })
  })
})

describe('collaboration: a DM is a channel (features reuse)', () => {
  it('post + list + react + mention all work in a DM with no DM-specific code', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, a, b } = await freshOrg()
    const dm = await createDm(db, { organizationId: orgId, actorUserId: a, otherUserId: b })
    if ('error' in dm) throw new Error('unexpected')
    const channelId = dm.channel.id
    // Post (with a mention of the other participant) works.
    const posted = await postMessage(db, {
      organizationId: orgId,
      channelId,
      authorUserId: a,
      body: 'hi @b',
      mentions: [b]
    })
    expect(posted.ok).toBe(true)
    if (!posted.ok) return
    await addReaction(db, {
      organizationId: orgId,
      channelId,
      messageId: posted.message.id,
      userId: b,
      emoji: '👍'
    })
    const list = await listChannelMessages(db, orgId, channelId, b)
    expect(list.ok && list.messages.map((m) => m.body)).toEqual(['hi @b'])
    const enriched = await getMessageWithReactions(db, orgId, posted.message.id, b)
    expect(enriched?.reactions).toEqual([{ emoji: '👍', count: 1, reactedByMe: true }])
    // The mention created a notification for b (the DM is a channel, so mentions work).
    const mentionRow = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('collaboration.message_mentions')
        .select('mentioned_user_id')
        .where('message_id', '=', posted.message.id)
        .execute()
    )
    expect(mentionRow.map((m) => m.mentioned_user_id)).toEqual([b])
  })

  it('listChannels ?kind=dm returns only DMs the caller is in', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, a, b } = await freshOrg()
    const dm = await createDm(db, { organizationId: orgId, actorUserId: a, otherUserId: b })
    if ('error' in dm) throw new Error('unexpected')
    const dms = await listChannels(db, orgId, a, { kind: 'dm' })
    expect(dms.map((c) => c.id)).toEqual([dm.channel.id])
    // b is in the DM; c (not created here) is not — b sees it, the DM count is 1.
    expect((await listChannels(db, orgId, b, { kind: 'dm' })).length).toBe(1)
  })
})
