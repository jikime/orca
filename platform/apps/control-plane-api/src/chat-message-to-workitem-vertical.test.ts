import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  addChannelMember,
  createDatabase,
  createDatabasePool,
  convertMessageToWorkItem,
  listWorkItemLinksForMessage,
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
let memberId = '' // channel member WITH work_item.create (member role)
let partnerId = '' // channel member WITHOUT work_item.create (partner role)
let strangerId = '' // has work_item.create but is NOT a channel member
let channelId = ''
let teamId = ''

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

async function postMsg(token: string, body: string): Promise<string> {
  const r = await bearerFetch(token, `/v1/organizations/${orgId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ body })
  })
  expect(r.status).toBe(201)
  return (await jsonOf<{ id: string }>(r)).id
}

function convertPath(messageId: string): string {
  return `/v1/organizations/${orgId}/channels/${channelId}/messages/${messageId}/work-items`
}

type WorkItem = {
  id: string
  identifier: string
  title: string
  teamId: string
  description: string | null
  assigneeId: string | null
}

async function convert(
  token: string,
  messageId: string,
  body: Record<string, unknown>,
  key = randomUUID()
): Promise<Response> {
  return bearerFetch(token, convertPath(messageId), {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: JSON.stringify(body)
  })
}

// Ground-truth link rows for a message (RLS-safe org tenant read).
async function linkRowsFor(messageId: string): Promise<Array<{ work_item_id: string }>> {
  return withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('collaboration.message_work_item_links')
      .select('work_item_id')
      .where('message_id', '=', messageId)
      .execute()
  )
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED chat message→workitem vertical: Docker unavailable — ${String(error)}`)
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
    slug: `m2w-${orgId.slice(0, 8)}`,
    displayName: 'M2W'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  memberId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'member',
      roleIds: ['member']
    })
  ).userId
  // partner role: message.read + message.post but NOT work_item.create — the dual-gate loser.
  partnerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'partner',
      roleIds: ['partner']
    })
  ).userId
  strangerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'stranger',
      roleIds: ['member']
    })
  ).userId
  const team = await jsonOf<{ id: string }>(
    await bearerFetch('owner', `/v1/organizations/${orgId}/teams`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ key: 'OPS', name: 'Ops' })
    })
  )
  teamId = team.id
  const channel = await jsonOf<{ id: string }>(
    await bearerFetch('owner', `/v1/organizations/${orgId}/channels`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'general' })
    })
  )
  channelId = channel.id
  // Roster: owner (creator) + member + partner. stranger is an org member but NOT on the channel.
  await addChannelMember(db, { organizationId: orgId, channelId, userId: memberId })
  await addChannelMember(db, { organizationId: orgId, channelId, userId: partnerId })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat message→workitem vertical', () => {
  it('a member with work_item.create converts a message → work item + link row', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'the deploy is flapping, someone should own this')
    const r = await convert('member', messageId, {
      teamId,
      title: 'Own the flapping deploy',
      assigneeId: memberId
    })
    expect(r.status).toBe(201)
    const location = r.headers.get('location')
    const workItem = await jsonOf<WorkItem>(r)
    expect(location).toBe(`/v1/organizations/${orgId}/work-items/${workItem.id}`)
    expect(workItem.teamId).toBe(teamId)
    expect(workItem.identifier).toMatch(/^OPS-\d+$/) // team-scoped identifier
    expect(workItem.title).toBe('Own the flapping deploy')
    // The description carries a back-reference to the source message.
    expect(workItem.description).toContain(messageId)
    // Exactly one link row ties the message to the created work item.
    const links = await linkRowsFor(messageId)
    expect(links).toHaveLength(1)
    expect(links[0]?.work_item_id).toBe(workItem.id)
    const sources = await jsonOf<{
      items: Array<{ kind: string; sourceId: string; containerId: string; containerLabel: string }>
    }>(
      await bearerFetch(
        'member',
        `/v1/organizations/${orgId}/work-items/${workItem.id}/source-bindings`
      )
    )
    expect(sources.items).toEqual([
      expect.objectContaining({
        kind: 'chat_message',
        sourceId: messageId,
        containerId: channelId,
        containerLabel: 'general'
      })
    ])
    const hiddenSources = await jsonOf<{ items: unknown[] }>(
      await bearerFetch(
        'stranger',
        `/v1/organizations/${orgId}/work-items/${workItem.id}/source-bindings`
      )
    )
    expect(hiddenSources.items).toEqual([])
  })

  it('title is derived from the message body when omitted', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'ship the changelog before Friday')
    const r = await convert('member', messageId, { teamId })
    expect(r.status).toBe(201)
    const workItem = await jsonOf<WorkItem>(r)
    expect(workItem.title).toBe('ship the changelog before Friday')
  })

  it('is idempotent — same Idempotency-Key → one work item, one link', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'triage the pager storm')
    const key = randomUUID()
    const first = await convert('member', messageId, { teamId }, key)
    expect(first.status).toBe(201)
    const firstItem = await jsonOf<WorkItem>(first)
    const second = await convert('member', messageId, { teamId }, key)
    expect(second.status).toBe(201)
    const secondItem = await jsonOf<WorkItem>(second)
    expect(secondItem.id).toBe(firstItem.id) // replayed, not re-created
    const links = await linkRowsFor(messageId)
    expect(links).toHaveLength(1)
  })

  it('is source-idempotent across different Idempotency-Keys', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'convert this source only once')
    const first = await convert('member', messageId, { teamId }, randomUUID())
    expect(first.status).toBe(201)
    const firstItem = await jsonOf<WorkItem>(first)
    const second = await convert('member', messageId, { teamId }, randomUUID())
    expect(second.status).toBe(200)
    const secondItem = await jsonOf<WorkItem>(second)
    expect(secondItem.id).toBe(firstItem.id)
    expect(await linkRowsFor(messageId)).toHaveLength(1)
  })

  it('a member lacking work_item.create is denied 403 (dual gate)', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'partner can read but not convert')
    const r = await convert('partner', messageId, { teamId })
    expect(r.status).toBe(403)
    expect(await linkRowsFor(messageId)).toHaveLength(0)
  })

  it('a non-member of the source channel is denied 403', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'members only conversion')
    const r = await convert('stranger', messageId, { teamId })
    expect(r.status).toBe(403)
    expect(await linkRowsFor(messageId)).toHaveLength(0)
  })

  it('converting a DELETED message is rejected (409)', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'about to be deleted')
    const del = await bearerFetch(
      'member',
      `/v1/organizations/${orgId}/channels/${channelId}/messages/${messageId}`,
      { method: 'DELETE' }
    )
    expect(del.status).toBe(204)
    const r = await convert('member', messageId, { teamId })
    expect(r.status).toBe(409)
    expect(await linkRowsFor(messageId)).toHaveLength(0)
  })

  it('an unknown source message is 404', async (ctx) => {
    if (!harness) return ctx.skip()
    const r = await convert('member', randomUUID(), { teamId })
    expect(r.status).toBe(404)
  })

  it('an invalid teamId is 422 (no work item, no link)', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'bad team target')
    const r = await convert('member', messageId, { teamId: randomUUID() })
    expect(r.status).toBe(422)
    expect(await linkRowsFor(messageId)).toHaveLength(0)
  })

  it('a missing Idempotency-Key is rejected 400', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'no key provided')
    const r = await bearerFetch('member', convertPath(messageId), {
      method: 'POST',
      body: JSON.stringify({ teamId })
    })
    expect(r.status).toBe(400)
  })

  it('the created work item is a real, listable delivery work item', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'this becomes a listed work item')
    const r = await convert('member', messageId, {
      teamId,
      title: 'Listed conversion',
      assigneeId: memberId
    })
    expect(r.status).toBe(201)
    const workItem = await jsonOf<WorkItem>(r)
    // It appears in the delivery work-item list.
    const list = await jsonOf<{ items: WorkItem[] }>(
      await bearerFetch('member', `/v1/organizations/${orgId}/work-items?assignee=me`)
    )
    expect(list.items.some((w) => w.id === workItem.id)).toBe(true)
    // And in the per-message conversion-link read model.
    const linkList = await jsonOf<{ items: Array<{ workItemId: string; createdBy: string }> }>(
      await bearerFetch('member', convertPath(messageId))
    )
    expect(linkList.items.some((l) => l.workItemId === workItem.id)).toBe(true)
    expect(linkList.items[0]?.createdBy).toBe(memberId)
  })

  it('store-level: convertMessageToWorkItem gates non-members and unknown messages', async (ctx) => {
    if (!harness) return ctx.skip()
    const messageId = await postMsg('member', 'store gate check')
    expect(
      await convertMessageToWorkItem(db, {
        organizationId: orgId,
        actorUserId: strangerId,
        channelId,
        messageId,
        teamId
      })
    ).toEqual({ ok: false, reason: 'source_forbidden' })
    expect(
      await convertMessageToWorkItem(db, {
        organizationId: orgId,
        actorUserId: memberId,
        channelId,
        messageId: randomUUID(),
        teamId
      })
    ).toEqual({ ok: false, reason: 'source_not_found' })
    // A successful store call returns the work item + link id, and the read model lists it.
    const ok = await convertMessageToWorkItem(db, {
      organizationId: orgId,
      actorUserId: memberId,
      channelId,
      messageId,
      teamId
    })
    expect(ok.ok).toBe(true)
    const links = await listWorkItemLinksForMessage(db, orgId, messageId)
    expect(links).toHaveLength(1)
    if (ok.ok) expect(links[0]?.workItemId).toBe(ok.workItem.id)
  })
})
