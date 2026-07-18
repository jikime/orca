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

function org(suffix: string): string {
  return `/v1/organizations/${orgId}${suffix}`
}

type Asset = { id: string; version: number; status: string; assignedToUserId: string | null }

async function createAsset(body: Record<string, unknown>, token = 'owner'): Promise<Response> {
  return bearerFetch(token, org('/assets'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

function transition(id: string, action: string, version: number): Promise<Response> {
  return bearerFetch('owner', org(`/assets/${id}:transition`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID(), 'if-match': `"asset-${version}"` },
    body: JSON.stringify({ action })
  })
}

function assign(id: string, assignedToUserId: string | null, version: number): Promise<Response> {
  return bearerFetch('owner', org(`/assets/${id}:assign`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID(), 'if-match': `"asset-${version}"` },
    body: JSON.stringify({ assignedToUserId })
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED asset vertical: Docker unavailable — ${String(error)}`)
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
    slug: `asset-${orgId.slice(0, 8)}`,
    displayName: 'Assets'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `asset2-${otherOrgId.slice(0, 8)}`,
    displayName: 'Assets2'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // 'member' has asset.read but NOT asset.manage — used for the create deny.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
  // 'other' owns a DIFFERENT org — used for cross-tenant isolation.
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

describe('asset vertical (R8 asset registry / CMDB)', () => {
  it('(a) per-customer registry: list filtered by accountId includes own, excludes another account', async (ctx) => {
    if (!harness) return ctx.skip()
    const accountId = randomUUID()
    const projectId = randomUUID()
    const created = await jsonOf<Asset>(
      await createAsset({
        name: 'Dev laptop',
        assetType: 'hardware',
        accountId,
        projectId,
        identifier: 'SN-12345'
      })
    )
    expect(created.status).toBe('active')

    const mine = await jsonOf<{ items: { id: string }[] }>(
      await bearerFetch('owner', org(`/assets?accountId=${accountId}`))
    )
    expect(mine.items.map((a) => a.id)).toContain(created.id)

    const others = await jsonOf<{ items: { id: string }[] }>(
      await bearerFetch('owner', org(`/assets?accountId=${randomUUID()}`))
    )
    expect(others.items.map((a) => a.id)).not.toContain(created.id)
  })

  it('(b) status :transition active → in_repair → retired under OCC (428 / 409 / 200) + status_changed event', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await jsonOf<Asset>(await createAsset({ name: 'Server rack' }))

    // Missing If-Match → 428.
    const noIfMatch = await bearerFetch('owner', org(`/assets/${created.id}:transition`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ action: 'repair' })
    })
    expect(noIfMatch.status).toBe(428)

    const repaired = await jsonOf<Asset>(await transition(created.id, 'repair', created.version))
    expect(repaired.status).toBe('in_repair')

    // Stale version → 409.
    const stale = await transition(created.id, 'retire', created.version)
    expect(stale.status).toBe(409)

    const retired = await jsonOf<Asset>(await transition(created.id, 'retire', repaired.version))
    expect(retired.status).toBe('retired')

    const events = await jsonOf<{ items: { eventKind: string }[] }>(
      await bearerFetch('owner', org(`/assets/${created.id}/events`))
    )
    const kinds = events.items.map((e) => e.eventKind)
    expect(kinds).toContain('created')
    expect(kinds.filter((k) => k === 'status_changed').length).toBe(2)
  })

  it('(c) :assign to a user writes an assigned event (OCC)', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await jsonOf<Asset>(await createAsset({ name: 'Monitor' }))
    const assignee = randomUUID()
    const assigned = await jsonOf<Asset>(await assign(created.id, assignee, created.version))
    expect(assigned.assignedToUserId).toBe(assignee)

    const events = await jsonOf<{ items: { eventKind: string }[] }>(
      await bearerFetch('owner', org(`/assets/${created.id}/events`))
    )
    expect(events.items.map((e) => e.eventKind)).toContain('assigned')
  })

  it('(d) CMDB link asset → ticket; list-by-asset returns it; duplicate rejected by unique constraint (409)', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await jsonOf<Asset>(await createAsset({ name: 'Firewall' }))
    const ticketId = randomUUID()
    const link = await bearerFetch('owner', org(`/assets/${created.id}/links`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ linkedKind: 'ticket', linkedId: ticketId, relation: 'affected_by' })
    })
    expect(link.status).toBe(201)

    const listed = await jsonOf<{ items: { linkedId: string; linkedKind: string }[] }>(
      await bearerFetch('owner', org(`/assets/${created.id}/links`))
    )
    expect(listed.items.some((l) => l.linkedId === ticketId && l.linkedKind === 'ticket')).toBe(
      true
    )

    // Same edge again → the UNIQUE constraint rejects it as a duplicate (409).
    const dup = await bearerFetch('owner', org(`/assets/${created.id}/links`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ linkedKind: 'ticket', linkedId: ticketId, relation: 'affected_by' })
    })
    expect(dup.status).toBe(409)
  })

  it('(e) RBAC: a member without asset.manage cannot create an asset (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const denied = await createAsset({ name: 'x' }, 'member')
    expect(denied.status).toBe(403)
  })

  it('(f) cross-tenant: another org owner cannot read this org asset (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await jsonOf<Asset>(await createAsset({ name: 'Isolated' }))
    const denied = await bearerFetch('other', org(`/assets/${created.id}`))
    expect(denied.status).toBe(403)
  })
})
