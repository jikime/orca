import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  runMigrations,
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
import { createGatewayConnectionAuthorizer } from './gateway-connection-authorizer'
import { createRealtimeGateway, type RealtimeGateway } from './realtime-gateway'
import { createTestTokenVerifier, TEST_ISSUER } from './authorization-test-support'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let gateway: RealtimeGateway
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let teamId = ''

function owner(path: string, key: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer owner',
      'content-type': 'application/json',
      'idempotency-key': key
    },
    body: JSON.stringify(body)
  })
}

async function jsonOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

async function listCount(path: string): Promise<number> {
  const r = await fetch(`${baseUrl}${path}`, { headers: { authorization: 'Bearer owner' } })
  const body = (await r.json()) as { items: unknown[] }
  return body.items.length
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED idempotency vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  const verifier = createTestTokenVerifier()
  gateway = createRealtimeGateway({
    db,
    registry,
    listenConnectionString: harness.connectionString,
    heartbeatIntervalMs: 60_000,
    authorizeConnection: createGatewayConnectionAuthorizer(db, verifier)
  })
  app = buildApp({ ping: async () => true, db, registry, gateway, tokenVerifier: verifier })
  await app.ready()
  await gateway.start()
  await app.listen({ host: '127.0.0.1', port: 0 })
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `id-${orgId.slice(0, 8)}`,
    displayName: 'ID'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const team = await jsonOf<{ id: string }>(
    await owner(`/v1/organizations/${orgId}/teams`, randomUUID(), { key: 'CORE', name: 'Core' })
  )
  teamId = team.id
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('idempotency dedup on delivery creates', () => {
  it('createTeam replays the same team (not TEAM_KEY_TAKEN) on a same-key retry', async (ctx) => {
    if (!harness) return ctx.skip()
    const key = randomUUID()
    const body = { key: 'DUP', name: 'Dup Team' }
    const first = await owner(`/v1/organizations/${orgId}/teams`, key, body)
    const second = await owner(`/v1/organizations/${orgId}/teams`, key, body)
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    const a = await jsonOf<{ id: string }>(first)
    const b = await jsonOf<{ id: string }>(second)
    expect(b.id).toBe(a.id)
    const teams = await jsonOf<{ items: Array<{ key: string }> }>(
      await fetch(`${baseUrl}/v1/organizations/${orgId}/teams`, {
        headers: { authorization: 'Bearer owner' }
      })
    )
    expect(teams.items.filter((t) => t.key === 'DUP').length).toBe(1)
  })

  it('createProject dedups a same-key+payload retry to one row', async (ctx) => {
    if (!harness) return ctx.skip()
    const key = randomUUID()
    const body = { name: `Proj ${key}` }
    const before = await listCount(`/v1/organizations/${orgId}/projects`)
    const a = await jsonOf<{ id: string }>(
      await owner(`/v1/organizations/${orgId}/projects`, key, body)
    )
    const b = await jsonOf<{ id: string }>(
      await owner(`/v1/organizations/${orgId}/projects`, key, body)
    )
    expect(b.id).toBe(a.id)
    expect(await listCount(`/v1/organizations/${orgId}/projects`)).toBe(before + 1)
  })

  it('createWorkItem dedups a same-key+payload retry to one identifier', async (ctx) => {
    if (!harness) return ctx.skip()
    const key = randomUUID()
    const body = { teamId, title: `WI ${key}` }
    const before = await listCount(`/v1/organizations/${orgId}/work-items`)
    const a = await jsonOf<{ id: string; identifier: string }>(
      await owner(`/v1/organizations/${orgId}/work-items`, key, body)
    )
    const b = await jsonOf<{ id: string; identifier: string }>(
      await owner(`/v1/organizations/${orgId}/work-items`, key, body)
    )
    expect(b.id).toBe(a.id)
    expect(b.identifier).toBe(a.identifier)
    expect(await listCount(`/v1/organizations/${orgId}/work-items`)).toBe(before + 1)
  })

  it('createComment dedups a same-key+payload retry to one comment', async (ctx) => {
    if (!harness) return ctx.skip()
    const item = await jsonOf<{ id: string }>(
      await owner(`/v1/organizations/${orgId}/work-items`, randomUUID(), {
        teamId,
        title: 'For comments'
      })
    )
    const key = randomUUID()
    const body = { body: 'idempotent comment', visibility: 'project' }
    const a = await jsonOf<{ id: string }>(
      await owner(`/v1/organizations/${orgId}/work-items/${item.id}/comments`, key, body)
    )
    const b = await jsonOf<{ id: string }>(
      await owner(`/v1/organizations/${orgId}/work-items/${item.id}/comments`, key, body)
    )
    expect(b.id).toBe(a.id)
    expect(await listCount(`/v1/organizations/${orgId}/work-items/${item.id}/comments`)).toBe(1)
  })

  it('rejects a same key with a different payload → 409 IDEMPOTENCY_KEY_REUSED', async (ctx) => {
    if (!harness) return ctx.skip()
    const key = randomUUID()
    await owner(`/v1/organizations/${orgId}/work-items`, key, { teamId, title: 'Original' })
    const reused = await owner(`/v1/organizations/${orgId}/work-items`, key, {
      teamId,
      title: 'Different'
    })
    expect(reused.status).toBe(409)
    const problem = await jsonOf<{ code?: string }>(reused)
    expect(problem.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('two concurrent same-key creates yield exactly one row', async (ctx) => {
    if (!harness) return ctx.skip()
    const key = randomUUID()
    const body = { teamId, title: `Concurrent ${key}` }
    const before = await listCount(`/v1/organizations/${orgId}/work-items`)
    const [r1, r2] = await Promise.all([
      owner(`/v1/organizations/${orgId}/work-items`, key, body),
      owner(`/v1/organizations/${orgId}/work-items`, key, body)
    ])
    // One creates (201); the other either replays (201) or is told in-progress (409).
    const statuses = [r1.status, r2.status].sort()
    expect(statuses[0]).toBe(201)
    expect([201, 409]).toContain(statuses[1])
    expect(await listCount(`/v1/organizations/${orgId}/work-items`)).toBe(before + 1)
  })
})
