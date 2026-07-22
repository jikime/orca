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
import { createContractSchemaRegistry } from './contract-schema-registry'
import { createTestTokenVerifier, TEST_ISSUER } from './authorization-test-support'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let channelId = ''

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

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function preferencesPath(): string {
  return `/v1/organizations/${orgId}/notifications/preferences`
}

function levelPath(): string {
  return `/v1/organizations/${orgId}/channels/${channelId}/notification-level`
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED notification preferences vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  const registry = createContractSchemaRegistry()
  app = buildApp({
    ping: async () => true,
    db,
    registry,
    tokenVerifier: createTestTokenVerifier()
  })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `notify-${orgId.slice(0, 8)}`,
    displayName: 'Notification preferences'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'stranger',
    roleIds: ['member']
  })
  const channel = await bearerFetch('owner', `/v1/organizations/${orgId}/channels`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ name: 'alerts' })
  })
  channelId = (await jsonOf<{ id: string }>(channel)).id
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('chat notification preferences vertical', () => {
  it('returns defaults and persists desktop plus DND settings', async (ctx) => {
    if (!harness) return ctx.skip()
    const defaults = await jsonOf<{
      desktopEnabled: boolean
      dndEnabled: boolean
      timezone: string
      channelLevels: unknown[]
    }>(await bearerFetch('owner', preferencesPath()))
    expect(defaults).toMatchObject({
      desktopEnabled: true,
      dndEnabled: false,
      timezone: 'UTC',
      channelLevels: []
    })

    const updated = await bearerFetch('owner', preferencesPath(), {
      method: 'PUT',
      body: JSON.stringify({
        desktopEnabled: false,
        dndEnabled: true,
        dndStartMinute: 1260,
        dndEndMinute: 420,
        timezone: 'Asia/Seoul'
      })
    })
    expect(updated.status).toBe(200)
    expect(await jsonOf<Record<string, unknown>>(updated)).toMatchObject({
      desktopEnabled: false,
      dndEnabled: true,
      dndStartMinute: 1260,
      dndEndMinute: 420,
      timezone: 'Asia/Seoul'
    })
  })

  it('rejects invalid time zones without overwriting the saved schedule', async (ctx) => {
    if (!harness) return ctx.skip()
    const invalid = await bearerFetch('owner', preferencesPath(), {
      method: 'PUT',
      body: JSON.stringify({ timezone: 'Mars/Olympus' })
    })
    expect(invalid.status).toBe(400)
    expect((await jsonOf<{ code: string }>(invalid)).code).toBe('VALIDATION_FAILED')
    expect(
      (await jsonOf<{ timezone: string }>(await bearerFetch('owner', preferencesPath()))).timezone
    ).toBe('Asia/Seoul')
  })

  it('stores a per-channel level only for channel members', async (ctx) => {
    if (!harness) return ctx.skip()
    const setAll = await bearerFetch('owner', levelPath(), {
      method: 'PUT',
      body: JSON.stringify({ level: 'all' })
    })
    expect(setAll.status).toBe(204)
    const preferences = await jsonOf<{
      channelLevels: Array<{ channelId: string; level: string }>
    }>(await bearerFetch('owner', preferencesPath()))
    expect(preferences.channelLevels).toContainEqual({ channelId, level: 'all' })

    expect(
      (
        await bearerFetch('stranger', levelPath(), {
          method: 'PUT',
          body: JSON.stringify({ level: 'none' })
        })
      ).status
    ).toBe(403)
  })

  it('rejects unknown notification levels at the boundary', async (ctx) => {
    if (!harness) return ctx.skip()
    const response = await bearerFetch('owner', levelPath(), {
      method: 'PUT',
      body: JSON.stringify({ level: 'sometimes' })
    })
    expect(response.status).toBe(400)
  })
})
