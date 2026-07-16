import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'
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
let wsUrl = ''
let orgId = ''

function authFetch(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  })
}

async function seedMember(subject: string, roleIds: string[]): Promise<string> {
  const { userId } = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject,
    roleIds
  })
  return userId
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED revoke propagation: Docker/PostgreSQL unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
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
  const port = (app.server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/v1/realtime`

  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `rp-${orgId.slice(0, 8)}`,
    displayName: 'RP'
  })
  await seedMember('admin', ['organization_owner'])
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

// AUT-005 revoke-propagation-offline-suite
describe('revoke-propagation-offline-suite (AUT-005)', () => {
  it('a revoked membership is denied on the very next request (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    await seedMember('victim1', ['member'])
    const uid = await seedMember('victim1', ['member'])
    // Authorized before revoke.
    expect((await authFetch(`/v1/organizations/${orgId}/changes`, 'victim1')).status).toBe(200)
    // Admin revokes the membership.
    const revoke = await authFetch(
      `/v1/organizations/${orgId}/memberships/${uid}/revoke`,
      'admin',
      {
        method: 'POST'
      }
    )
    expect(revoke.status).toBe(200)
    // Next request denied.
    expect((await authFetch(`/v1/organizations/${orgId}/changes`, 'victim1')).status).toBe(403)
  })

  it('pushes session.revoked to the revoked member’s live WS connection', async (ctx) => {
    if (!harness) return ctx.skip()
    const uid = await seedMember('victim2', ['member'])
    const revoked: unknown[] = []
    const socket = new WebSocket(wsUrl, { headers: { authorization: 'Bearer victim2' } })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
    })
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as { type?: string; reason?: string }
      if (message.type === 'session.revoked') revoked.push(message)
    })
    socket.send(
      JSON.stringify({
        type: 'client.hello',
        schemaVersion: 1,
        protocolVersion: '1.0',
        instanceId: 'rp-test',
        organizationId: orgId,
        lastCursor: null
      })
    )
    await delay(250)
    await authFetch(`/v1/organizations/${orgId}/memberships/${uid}/revoke`, 'admin', {
      method: 'POST'
    })
    for (let i = 0; i < 60 && revoked.length === 0; i++) {
      await delay(50)
    }
    expect(revoked.length).toBeGreaterThanOrEqual(1)
    socket.close()
  })

  it('a revoked session rejects the same token on the next request (401)', async (ctx) => {
    if (!harness) return ctx.skip()
    await seedMember('victim3', ['member'])
    // Establish the session record (GET /v1/session records the device session).
    expect((await authFetch('/v1/session', 'victim3')).status).toBe(200)
    // Revoke the current session.
    const revoke = await authFetch('/v1/sessions/revoke', 'victim3', {
      method: 'POST',
      body: JSON.stringify({ scope: 'current' })
    })
    expect(revoke.status).toBe(200)
    // The verifier now rejects the (still-unexpired) token.
    expect((await authFetch(`/v1/organizations/${orgId}/changes`, 'victim3')).status).toBe(401)
  })

  it('blocks removing the last owner via the API (409)', async (ctx) => {
    if (!harness) return ctx.skip()
    const soleOrg = randomUUID()
    await seedOrganizationFixture(db, {
      id: soleOrg,
      slug: `sole-${soleOrg.slice(0, 8)}`,
      displayName: 'Sole'
    })
    const ownerId = (
      await seedMembershipFixture(db, {
        organizationId: soleOrg,
        issuer: TEST_ISSUER,
        subject: 'sole-owner',
        roleIds: ['organization_owner']
      })
    ).userId
    const revoke = await authFetch(
      `/v1/organizations/${soleOrg}/memberships/${ownerId}/revoke`,
      'sole-owner',
      {
        method: 'POST'
      }
    )
    expect(revoke.status).toBe(409)
  })
})

describe('invitation HTTP round-trip', () => {
  it('creates an invite and accepts it, creating a membership', async (ctx) => {
    if (!harness) return ctx.skip()
    const create = await authFetch(`/v1/organizations/${orgId}/invitations`, 'admin', {
      method: 'POST',
      body: JSON.stringify({ email: 'newjoiner@test', userType: 'internal', roleIds: ['member'] })
    })
    expect(create.status).toBe(201)
    const { rawToken } = (await create.json()) as { rawToken: string }
    expect(typeof rawToken).toBe('string')

    // The invitee (subject 'newjoiner' → email newjoiner@test) accepts.
    const accept = await authFetch('/v1/invitations/accept', 'newjoiner', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken })
    })
    expect(accept.status).toBe(200)
    const body = (await accept.json()) as { organizationId: string }
    expect(body.organizationId).toBe(orgId)
    // The new member can now read the org (RBAC allows).
    expect((await authFetch(`/v1/organizations/${orgId}/changes`, 'newjoiner')).status).toBe(200)
  })
})
