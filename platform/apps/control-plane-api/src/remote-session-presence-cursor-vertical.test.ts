import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  decodeEphemeralNotification,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedEntitlementManifest,
  withoutTenantContext,
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
let sessionId = ''
let bUserId = ''

type Frame = {
  type?: string
  sessionId?: string
  participantId?: string
  userId?: string
  state?: string
  row?: number
  col?: number
}

type Client = { socket: WebSocket; frames: Frame[]; close: () => void }

async function connect(token: string): Promise<Client> {
  const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } })
  const frames: Frame[] = []
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
  })
  socket.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString()) as Frame))
  socket.send(
    JSON.stringify({
      type: 'client.hello',
      schemaVersion: 1,
      protocolVersion: '1.0',
      instanceId: `rs-${randomUUID().slice(0, 8)}`,
      organizationId: orgId,
      lastCursor: null
    })
  )
  await delay(200)
  return { socket, frames, close: () => socket.close() }
}

async function waitFor(client: Client, predicate: (f: Frame) => boolean): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (client.frames.some(predicate)) return true
    await delay(50)
  }
  return client.frames.some(predicate)
}

function presence(token: string, targetSessionId: string, state: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/organizations/${orgId}/remote-sessions/${targetSessionId}/presence`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state })
  })
}

function cursor(token: string, row: number, col: number): Promise<Response> {
  return fetch(`${baseUrl}/v1/organizations/${orgId}/remote-sessions/${sessionId}/cursor`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ row, col })
  })
}

async function createSession(): Promise<{ id: string; version: number }> {
  const res = await fetch(`${baseUrl}/v1/organizations/${orgId}/remote-sessions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer a',
      'content-type': 'application/json',
      'idempotency-key': randomUUID()
    },
    body: JSON.stringify({ kind: 'terminal', hostUserId: bUserId })
  })
  const wire = (await res.json()) as { id: string; version: number }
  return { id: wire.id, version: wire.version }
}

async function durableCounts(): Promise<{ outbox: number; cursors: number }> {
  return withoutTenantContext(db, async (trx) => ({
    outbox: Number(
      (
        await trx
          .selectFrom('operations.outbox_events')
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirstOrThrow()
      ).n
    ),
    cursors: Number(
      (
        await trx
          .selectFrom('operations.stream_cursors')
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirstOrThrow()
      ).n
    )
  }))
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(
      `SKIPPED remote-session presence/cursor vertical: Docker unavailable — ${String(error)}`
    )
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
  const port = (app.server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/v1/realtime`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `rs-${orgId.slice(0, 8)}`,
    displayName: 'RS'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'a',
    roleIds: ['organization_owner']
  })
  bUserId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'b',
      roleIds: ['organization_owner']
    })
  ).userId
  // c is a member but NEVER added to the session — the non-participant.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'c',
    roleIds: ['organization_owner']
  })
  const created = await createSession()
  sessionId = created.id
  // Add b as an active participant (a is the admin participant from creation).
  await fetch(`${baseUrl}/v1/organizations/${orgId}/remote-sessions/${sessionId}/participants`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer a',
      'content-type': 'application/json',
      'idempotency-key': randomUUID()
    },
    body: JSON.stringify({ userId: bUserId, grade: 'terminal_control' })
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('ephemeral: remote-session presence', () => {
  it('reaches a session participant, not a non-participant, and writes no durable row', async (ctx) => {
    if (!harness) return ctx.skip()
    const b = await connect('b')
    const c = await connect('c')
    const before = await durableCounts()
    await delay(1100) // clear any shared per-participant coalesce window
    const r = await presence('a', sessionId, 'online')
    expect(r.status).toBe(204)
    expect(
      await waitFor(
        b,
        (f) =>
          f.type === 'remote_presence.changed' && f.sessionId === sessionId && f.state === 'online'
      )
    ).toBe(true)
    await delay(300)
    // c is not a session participant — must not learn about the session's presence.
    expect(c.frames.some((f) => f.type === 'remote_presence.changed')).toBe(false)
    const after = await durableCounts()
    expect(after).toEqual(before)
    b.close()
    c.close()
  })

  it('rejects a non-participant post with 403', async (ctx) => {
    if (!harness) return ctx.skip()
    const r = await presence('c', sessionId, 'online')
    expect(r.status).toBe(403)
  })

  it('coalesces a rapid second ping', async (ctx) => {
    if (!harness) return ctx.skip()
    const b = await connect('b')
    await delay(1100)
    for (let i = 0; i < 5; i++) await presence('a', sessionId, 'online')
    await delay(400)
    const pings = b.frames.filter((f) => f.type === 'remote_presence.changed').length
    expect(pings).toBeGreaterThanOrEqual(1)
    expect(pings).toBeLessThanOrEqual(2)
    b.close()
  })

  it('rejects presence/cursor after the session has ended', async (ctx) => {
    if (!harness) return ctx.skip()
    const fresh = await createSession()
    const transition = await fetch(
      `${baseUrl}/v1/organizations/${orgId}/remote-sessions/${fresh.id}:transition`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer a',
          'content-type': 'application/json',
          'if-match': `"remote-session-${fresh.version}"`
        },
        body: JSON.stringify({ toStatus: 'ended' })
      }
    )
    expect(transition.status).toBe(200)
    const r = await presence('a', fresh.id, 'online')
    expect(r.status).toBe(409)
  })
})

describe('ephemeral: remote-session cursor', () => {
  it('delivers row/col to a participant and rejects a negative coordinate', async (ctx) => {
    if (!harness) return ctx.skip()
    const b = await connect('b')
    await delay(200)
    const r = await cursor('a', 12, 34)
    expect(r.status).toBe(204)
    expect(
      await waitFor(b, (f) => f.type === 'remote_cursor.changed' && f.row === 12 && f.col === 34)
    ).toBe(true)
    const bad = await cursor('a', -1, 5)
    expect(bad.status).toBe(400)
    b.close()
  })
})

describe('ephemeral decode', () => {
  it('round-trips remote presence/cursor and rejects malformed payloads', () => {
    expect(
      decodeEphemeralNotification(
        JSON.stringify({
          kind: 'remote_presence',
          organizationId: 'o',
          sessionId: 's',
          participantId: 'p',
          userId: 'u',
          state: 'online',
          role: 'terminal_control',
          at: '2026-07-16T00:00:00.000Z'
        })
      )
    ).toEqual({
      kind: 'remote_presence',
      organizationId: 'o',
      sessionId: 's',
      participantId: 'p',
      userId: 'u',
      state: 'online',
      role: 'terminal_control',
      at: '2026-07-16T00:00:00.000Z'
    })
    // Negative cursor coordinate → malformed → null.
    expect(
      decodeEphemeralNotification(
        JSON.stringify({
          kind: 'remote_cursor',
          organizationId: 'o',
          sessionId: 's',
          participantId: 'p',
          row: -1,
          col: 0,
          at: '2026-07-16T00:00:00.000Z'
        })
      )
    ).toBeNull()
    // Missing role → malformed → null.
    expect(
      decodeEphemeralNotification(
        JSON.stringify({
          kind: 'remote_presence',
          organizationId: 'o',
          sessionId: 's',
          participantId: 'p',
          userId: 'u',
          state: 'online',
          at: '2026-07-16T00:00:00.000Z'
        })
      )
    ).toBeNull()
  })
})
