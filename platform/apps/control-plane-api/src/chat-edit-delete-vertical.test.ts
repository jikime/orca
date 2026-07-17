import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  addChannelMember,
  createDatabase,
  createDatabasePool,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedEntitlementManifest,
  withTenantTransaction,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import {
  createContractSchemaRegistry,
  type ContractSchemaRegistry
} from './contract-schema-registry'
import { createTestTokenVerifier, TEST_ISSUER } from './authorization-test-support'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let channelId = ''
let authorUserId = ''
let ownerUserId = ''

type Msg = {
  id: string
  body: string
  version: number
  edited?: boolean
  revisionCount?: number
  deleted?: boolean
  deletedAt?: string | null
  deletedBy?: string | null
  deletionReason?: string | null
  threadRootMessageId?: string | null
}

function bearerFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  })
}

async function jsonOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

function postMsg(token: string, body: Record<string, unknown>): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

function editMsgReq(
  token: string,
  messageId: string,
  version: number | null,
  body: string
): Promise<Response> {
  return bearerFetch(
    token,
    `/v1/organizations/${orgId}/channels/${channelId}/messages/${messageId}`,
    {
      method: 'PATCH',
      headers: {
        'idempotency-key': randomUUID(),
        ...(version === null ? {} : { 'if-match': `"message-${version}"` })
      },
      body: JSON.stringify({ body })
    }
  )
}

function deleteMsgReq(token: string, messageId: string, reason?: string): Promise<Response> {
  return bearerFetch(
    token,
    `/v1/organizations/${orgId}/channels/${channelId}/messages/${messageId}`,
    {
      method: 'DELETE',
      headers: { 'idempotency-key': randomUUID() },
      ...(reason ? { body: JSON.stringify({ reason }) } : {})
    }
  )
}

async function listMessages(token: string, threadRoot?: string): Promise<Msg[]> {
  const qs = threadRoot ? `?threadRoot=${threadRoot}` : ''
  const res = await bearerFetch(
    token,
    `/v1/organizations/${orgId}/channels/${channelId}/messages${qs}`
  )
  const page = await jsonOf<{ items: Msg[] }>(res)
  return page.items
}

async function findMessage(token: string, messageId: string): Promise<Msg | undefined> {
  const items = await listMessages(token)
  return items.find((m) => m.id === messageId)
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED edit/delete vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  const verifier = createTestTokenVerifier()
  app = buildApp({ ping: async () => true, db, registry, tokenVerifier: verifier })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `ed-${orgId.slice(0, 8)}`,
    displayName: 'ED'
  })
  // owner = moderator (organization_owner has channel.manage). author + member = plain
  // members (message.post/read, NO channel.manage).
  ownerUserId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  authorUserId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'author',
      roleIds: ['member']
    })
  ).userId
  const member3Id = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'member3',
      roleIds: ['member']
    })
  ).userId
  const channel = await jsonOf<{ id: string }>(
    await bearerFetch('owner', `/v1/organizations/${orgId}/channels`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'general' })
    })
  )
  channelId = channel.id
  await addChannelMember(db, { organizationId: orgId, channelId, userId: authorUserId })
  await addChannelMember(db, { organizationId: orgId, channelId, userId: member3Id })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat edit + delete (moderation slice 1) vertical', () => {
  it('(a) author edits own message: body changes, version bumps, original preserved, edited marker', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await jsonOf<Msg>(await postMsg('author', { body: 'original body' }))
    expect(posted.version).toBe(1)
    const res = await editMsgReq('author', posted.id, 1, 'edited body')
    expect(res.status).toBe(200)
    const edited = await jsonOf<Msg>(res)
    expect(edited.body).toBe('edited body')
    expect(edited.version).toBe(2)
    expect(edited.edited).toBe(true)
    expect(edited.revisionCount).toBe(2)
    expect(res.headers.get('etag')).toBe('"message-2"')
    // Original body is recoverable: revision 1 holds the pre-edit body, revision 2 the new.
    const revisions = await withTenantTransaction(db, orgId, async (trx) =>
      trx
        .selectFrom('collaboration.message_revisions')
        .select(['revision', 'body'])
        .where('message_id', '=', posted.id)
        .orderBy('revision')
        .execute()
    )
    expect(revisions.map((r) => ({ revision: Number(r.revision), body: r.body }))).toEqual([
      { revision: 1, body: 'original body' },
      { revision: 2, body: 'edited body' }
    ])
  })

  it('(b) a non-author (even a moderator) cannot edit — 403', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await jsonOf<Msg>(await postMsg('author', { body: 'mine only' }))
    // owner is a moderator (channel.manage) but edit is author-only.
    const res = await editMsgReq('owner', posted.id, posted.version, 'hijacked')
    expect(res.status).toBe(403)
  })

  it('(c) a stale expectedVersion (If-Match) is rejected — 409', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await jsonOf<Msg>(await postMsg('author', { body: 'v1' }))
    await editMsgReq('author', posted.id, 1, 'v2') // now at version 2
    const stale = await editMsgReq('author', posted.id, 1, 'racing') // stale If-Match
    expect(stale.status).toBe(409)
  })

  it('(d) author deletes own message: tombstone with redacted body, row + thread pointer remain', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await jsonOf<Msg>(await postMsg('author', { body: 'delete me' }))
    const res = await deleteMsgReq('author', posted.id)
    expect(res.status).toBe(204)
    const tomb = await findMessage('author', posted.id)
    expect(tomb).toBeDefined()
    expect(tomb?.deleted).toBe(true)
    expect(tomb?.body).toBe('')
    expect(tomb?.deletedBy).toBe(authorUserId)
    expect(tomb?.deletionReason).toBeNull()
  })

  it('(e) a moderator (non-author) deletes with a reason: tombstone records deletedBy + reason', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await jsonOf<Msg>(await postMsg('author', { body: 'moderate me' }))
    const res = await deleteMsgReq('owner', posted.id, 'off-topic')
    expect(res.status).toBe(204)
    const tomb = await findMessage('author', posted.id)
    expect(tomb?.deleted).toBe(true)
    expect(tomb?.body).toBe('')
    expect(tomb?.deletedBy).toBe(ownerUserId)
    expect(tomb?.deletionReason).toBe('off-topic')
  })

  it('(f) a moderator deleting another user message WITHOUT a reason is rejected — 400', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await jsonOf<Msg>(await postMsg('author', { body: 'needs a reason' }))
    const res = await deleteMsgReq('owner', posted.id)
    expect(res.status).toBe(400)
    // Not tombstoned — still visible with its body.
    const still = await findMessage('author', posted.id)
    expect(still?.deleted).not.toBe(true)
    expect(still?.body).toBe('needs a reason')
  })

  it('(g) a non-author non-moderator cannot delete — 403', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await jsonOf<Msg>(await postMsg('author', { body: 'not yours' }))
    const res = await deleteMsgReq('member3', posted.id)
    expect(res.status).toBe(403)
  })

  it('(h) editing a deleted message is rejected — 409', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await jsonOf<Msg>(await postMsg('author', { body: 'soon gone' }))
    await deleteMsgReq('author', posted.id)
    const res = await editMsgReq('author', posted.id, posted.version + 1, 'resurrect')
    expect(res.status).toBe(409)
  })

  it('(i) deleting a thread root still lists the root (as a tombstone) and its reply', async (ctx) => {
    if (!harness) return ctx.skip()
    const root = await jsonOf<Msg>(await postMsg('author', { body: 'thread root' }))
    const reply = await jsonOf<Msg>(
      await postMsg('author', { body: 'a reply', threadRootMessageId: root.id })
    )
    const del = await deleteMsgReq('author', root.id)
    expect(del.status).toBe(204)
    // The root remains in the timeline as a tombstone (thread integrity).
    const all = await listMessages('author')
    const rootInList = all.find((m) => m.id === root.id)
    expect(rootInList?.deleted).toBe(true)
    // The reply is still listed and still points at the (now tombstoned) root.
    const thread = await listMessages('author', root.id)
    expect(thread.map((m) => m.id)).toContain(reply.id)
    expect(thread.find((m) => m.id === reply.id)?.threadRootMessageId).toBe(root.id)
  })

  it('(j) re-deleting a tombstone is an idempotent no-op — 204', async (ctx) => {
    if (!harness) return ctx.skip()
    const posted = await jsonOf<Msg>(await postMsg('author', { body: 'delete twice' }))
    expect((await deleteMsgReq('author', posted.id)).status).toBe(204)
    expect((await deleteMsgReq('author', posted.id)).status).toBe(204)
  })
})
