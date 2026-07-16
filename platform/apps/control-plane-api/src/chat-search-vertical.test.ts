import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  runMigrations,
  searchMessages,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedEntitlementManifest,
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

let pgHarness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let app: FastifyInstance
let baseUrl = ''
let org1 = ''
let org2 = ''
let userCId = ''
let channelA = '' // channel created by A; C is NOT a member (member-scope negative)
let channelC = '' // channel created by C; C is a member (member-scope positive)

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

async function createChannel(token: string, orgId: string, name: string): Promise<string> {
  const channel = await jsonOf<{ id: string }>(
    await bearerFetch(token, `/v1/organizations/${orgId}/channels`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name })
    })
  )
  return channel.id
}

async function postMessage(
  token: string,
  orgId: string,
  channelId: string,
  body: string
): Promise<string> {
  const posted = await jsonOf<{ id: string }>(
    await bearerFetch(token, `/v1/organizations/${orgId}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ body })
    })
  )
  return posted.id
}

function search(token: string, orgId: string, qs: string): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/messages/search?${qs}`)
}

beforeAll(async () => {
  try {
    pgHarness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED search vertical: Docker/Postgres unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: pgHarness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  const verifier = createTestTokenVerifier()
  app = buildApp({ ping: async () => true, db, registry, tokenVerifier: verifier })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

  // org1: A (owner, subject 'a') and C (member, subject 'c').
  org1 = randomUUID()
  await seedOrganizationFixture(db, { id: org1, slug: `s1-${org1.slice(0, 8)}`, displayName: 'S1' })
  await seedMembershipFixture(db, {
    organizationId: org1,
    issuer: TEST_ISSUER,
    subject: 'a',
    roleIds: ['organization_owner']
  })
  userCId = (
    await seedMembershipFixture(db, {
      organizationId: org1,
      issuer: TEST_ISSUER,
      subject: 'c',
      roleIds: ['member']
    })
  ).userId

  // channelA: A is the sole member. channelC: C is the sole member. Same term in both.
  channelA = await createChannel('a', org1, 'a-only')
  channelC = await createChannel('c', org1, 'c-only')
  await postMessage('a', org1, channelA, 'kryptonite alpha in a channel C cannot see')
  await postMessage('c', org1, channelC, 'kryptonite beta in a channel C is on')

  // org2: D (owner, subject 'd') posts the SAME term — must never cross into org1 search.
  org2 = randomUUID()
  await seedOrganizationFixture(db, { id: org2, slug: `s2-${org2.slice(0, 8)}`, displayName: 'S2' })
  await seedMembershipFixture(db, {
    organizationId: org2,
    issuer: TEST_ISSUER,
    subject: 'd',
    roleIds: ['organization_owner']
  })
  const channelD = await createChannel('d', org2, 'other-org')
  await postMessage('d', org2, channelD, 'kryptonite gamma in a different org')
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await pgHarness?.stop()
})

describe('chat search vertical', () => {
  it('member-scope: a term in two channels returns only the caller-member channel hit', async (ctx) => {
    if (!pgHarness) return ctx.skip()
    const res = await search('c', org1, 'q=kryptonite')
    expect(res.status).toBe(200)
    const page = await jsonOf<{ items: Array<{ channelId: string; body: string }> }>(res)
    // Exactly one hit: channelC (C's channel). channelA's identical-term message is hidden.
    expect(page.items.length).toBe(1)
    expect(page.items[0]?.channelId).toBe(channelC)
    expect(page.items.some((m) => m.channelId === channelA)).toBe(false)
  })

  it('cross-org: a second org message with the same term is never returned', async (ctx) => {
    if (!pgHarness) return ctx.skip()
    const page = await jsonOf<{ items: Array<{ body: string }> }>(
      await search('c', org1, 'q=kryptonite')
    )
    expect(page.items.some((m) => m.body.includes('gamma'))).toBe(false)
    expect(page.items.some((m) => m.body.includes('different org'))).toBe(false)
  })

  it('keyset pagination returns no overlap across pages', async (ctx) => {
    if (!pgHarness) return ctx.skip()
    const pchannel = await createChannel('c', org1, 'paginate')
    for (let i = 0; i < 5; i++) await postMessage('c', org1, pchannel, `paginate zeta message ${i}`)
    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    do {
      const qs = `q=paginate&limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const page: { items: Array<{ id: string }>; nextCursor: string | null } = await jsonOf(
        await search('c', org1, qs)
      )
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false) // no id appears on two pages
        seen.add(item.id)
      }
      cursor = page.nextCursor
      pages++
    } while (cursor && pages < 10)
    expect(seen.size).toBe(5)
  })

  it('empty / whitespace q is a 400', async (ctx) => {
    if (!pgHarness) return ctx.skip()
    expect((await search('c', org1, 'q=')).status).toBe(400)
    expect((await search('c', org1, 'q=%20%20')).status).toBe(400)
    expect((await search('c', org1, '')).status).toBe(400) // q absent
  })

  it('a query that matches nothing returns an empty page', async (ctx) => {
    if (!pgHarness) return ctx.skip()
    const page = await jsonOf<{ items: unknown[]; nextCursor: string | null }>(
      await search('c', org1, 'q=zzzznomatchxyzzz')
    )
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('store-level: searchMessages enforces member-scope for the requesting user', async (ctx) => {
    if (!pgHarness) return ctx.skip()
    const result = await searchMessages(db, {
      organizationId: org1,
      userId: userCId,
      query: 'kryptonite',
      limit: 20
    })
    expect(result.items.length).toBe(1)
    expect(result.items[0]?.channelId).toBe(channelC)
  })
})
