import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  runMigrations,
  seedEntitlementManifest,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
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
let otherOrgId = ''
let ownerId = '' // organization_owner: knowledge.read + customer_read + manage + review

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

function kb(org: string, suffix: string): string {
  return `/v1/organizations/${org}/knowledge${suffix}`
}

function etag(version: number): string {
  return `"knowledge-article-${version}"`
}

type ArticleWire = {
  id: string
  title: string
  status: string
  visibility: string
  sourceType: string
  sourceId: string | null
  reviewStatus: string
  reviewedBy: string | null
  version: number
}

type SearchHit = { id: string; title: string; visibility: string; rank: number }

async function createArticle(token: string, body: Record<string, unknown>): Promise<ArticleWire> {
  const res = await bearerFetch(token, kb(orgId, '/articles'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
  expect(res.status).toBe(201)
  return jsonOf<ArticleWire>(res)
}

async function transition(
  token: string,
  id: string,
  action: string,
  version: number
): Promise<Response> {
  return bearerFetch(token, kb(orgId, `/articles/${id}:${action}`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID(), 'if-match': etag(version) }
  })
}

// Drive a manual article all the way to published (submit → publish). Manual source has no AI gate.
async function publishManual(token: string, body: Record<string, unknown>): Promise<ArticleWire> {
  const draft = await createArticle(token, { sourceType: 'manual', ...body })
  const submitted = await jsonOf<ArticleWire>(
    await transition(token, draft.id, 'submit-for-review', draft.version)
  )
  const published = await jsonOf<ArticleWire>(
    await transition(token, draft.id, 'publish', submitted.version)
  )
  expect(published.status).toBe('published')
  return published
}

async function search(token: string, q: string): Promise<SearchHit[]> {
  const res = await bearerFetch(token, kb(orgId, `/search?q=${encodeURIComponent(q)}`))
  expect(res.status).toBe(200)
  return (await jsonOf<{ items: SearchHit[] }>(res)).items
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED knowledge vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  app = buildApp({ ping: async () => true, db, registry, tokenVerifier: createTestTokenVerifier() })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  otherOrgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `kb-${orgId.slice(0, 8)}`,
    displayName: 'KB'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `kb2-${otherOrgId.slice(0, 8)}`,
    displayName: 'KB2'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  // 'member' holds knowledge.read only (no customer_read, no manage) — the internal-restricted caller.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
  // 'other' is an owner of a DIFFERENT org — cross-tenant isolation.
  await seedMembershipFixture(db, {
    organizationId: otherOrgId,
    issuer: TEST_ISSUER,
    subject: 'other',
    roleIds: ['organization_owner']
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('knowledge vertical (R7 knowledge base + permission-aware search)', () => {
  it('(a) EXIT CONDITION: an unreviewed AI article cannot be published; review approval unlocks it; manual publishes freely', async (ctx) => {
    if (!harness) return ctx.skip()
    const term = `neptune${orgId.slice(0, 6)}`
    const aiDraft = await createArticle('owner', {
      title: `${term} migration guide`,
      body: 'Distilled by the model from a resolved ticket.',
      sourceType: 'ai'
    })
    expect(aiDraft.sourceType).toBe('ai')
    const inReview = await jsonOf<ArticleWire>(
      await transition('owner', aiDraft.id, 'submit-for-review', aiDraft.version)
    )
    expect(inReview.status).toBe('in_review')
    // Publish refused while the AI article is unreviewed → 422 AI_REVIEW_REQUIRED.
    const refused = await transition('owner', aiDraft.id, 'publish', inReview.version)
    expect(refused.status).toBe(422)
    expect((await jsonOf<{ code: string }>(refused)).code).toBe('AI_REVIEW_REQUIRED')

    // A human reviewer approves (reviewer recorded), THEN publish succeeds.
    const reviewed = await jsonOf<ArticleWire>(
      await bearerFetch('owner', kb(orgId, `/articles/${aiDraft.id}:review`), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': etag(inReview.version) },
        body: JSON.stringify({ decision: 'approve' })
      })
    )
    expect(reviewed.reviewStatus).toBe('approved')
    expect(reviewed.reviewedBy).toBe(ownerId)
    const published = await jsonOf<ArticleWire>(
      await transition('owner', aiDraft.id, 'publish', reviewed.version)
    )
    expect(published.status).toBe('published')

    // A manual article reaches published with NO review gate.
    const manual = await publishManual('owner', {
      title: `${term} manual note`,
      body: 'Written by a human engineer.'
    })
    expect(manual.reviewStatus).toBe('unreviewed')
  })

  it('(b) permission-aware search filters by visibility at QUERY TIME (customer content gated)', async (ctx) => {
    if (!harness) return ctx.skip()
    const term = `saturn${orgId.slice(0, 6)}`
    const internal = await publishManual('owner', {
      title: `${term} internal runbook`,
      body: 'Internal-only knowledge.',
      visibility: 'internal'
    })
    const customer = await publishManual('owner', {
      title: `${term} customer FAQ`,
      body: 'Customer-facing knowledge.',
      visibility: 'customer'
    })
    // Owner may see customer content → both hits.
    const ownerHits = await search('owner', term)
    expect(ownerHits.map((h) => h.id).sort()).toEqual([internal.id, customer.id].sort())
    // Member is restricted to internal → only the internal hit.
    const memberHits = await search('member', term)
    expect(memberHits.map((h) => h.id)).toEqual([internal.id])

    // Flip the internal article to customer-visibility directly, then re-search: the member now sees
    // NOTHING (both are customer-visibility), proving the filter is re-evaluated per query, not indexed.
    await withTenantTransaction(db, orgId, (trx) =>
      trx
        .updateTable('knowledge.articles')
        .set({ visibility: 'customer' })
        .where('id', '=', internal.id)
        .execute()
    )
    const memberAfter = await search('member', term)
    expect(memberAfter).toHaveLength(0)
    const ownerAfter = await search('owner', term)
    expect(ownerAfter.map((h) => h.id).sort()).toEqual([internal.id, customer.id].sort())
  })

  it('(c) status :transition under OCC (200 / 409 stale / 428 no If-Match)', async (ctx) => {
    if (!harness) return ctx.skip()
    const draft = await createArticle('owner', {
      title: 'occ article',
      body: 'body',
      sourceType: 'manual'
    })
    const submitted = await jsonOf<ArticleWire>(
      await transition('owner', draft.id, 'submit-for-review', draft.version)
    )
    expect(submitted.status).toBe('in_review')
    // No If-Match → 428.
    const noIfMatch = await bearerFetch('owner', kb(orgId, `/articles/${draft.id}:publish`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() }
    })
    expect(noIfMatch.status).toBe(428)
    // Stale version → 409.
    const stale = await transition('owner', draft.id, 'publish', draft.version)
    expect(stale.status).toBe(409)
    // Correct version → 200.
    const ok = await jsonOf<ArticleWire>(
      await transition('owner', draft.id, 'publish', submitted.version)
    )
    expect(ok.status).toBe('published')
  })

  it('(d) knowledge-from-ticket: source_type/source_id captured; get returns them', async (ctx) => {
    if (!harness) return ctx.skip()
    const ticketId = randomUUID()
    const article = await createArticle('owner', {
      title: 'resolved ticket writeup',
      body: 'How we fixed it.',
      sourceType: 'ticket',
      sourceId: ticketId
    })
    expect(article.sourceType).toBe('ticket')
    expect(article.sourceId).toBe(ticketId)
    const fetched = await jsonOf<ArticleWire>(
      await bearerFetch('owner', kb(orgId, `/articles/${article.id}`))
    )
    expect(fetched.sourceId).toBe(ticketId)
  })

  it('(e) RBAC: a member without knowledge.manage cannot create (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const denied = await bearerFetch('member', kb(orgId, '/articles'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ title: 'x', body: 'y' })
    })
    expect(denied.status).toBe(403)
  })

  it('(f) cross-tenant: another org owner cannot read this org article (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const article = await createArticle('owner', {
      title: 'secret',
      body: 'tenant-bound',
      sourceType: 'manual'
    })
    const denied = await bearerFetch('other', kb(orgId, `/articles/${article.id}`))
    expect(denied.status).toBe(403)
  })
})
