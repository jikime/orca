import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  issueCapability,
  runMigrations,
  seedEntitlementManifest,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  withTenantTransaction,
  type CapabilityKind,
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

// The operator bearer the Relay presents to the internal relay-admit endpoint (a deployment secret).
const OPERATOR_TOKEN = 'relay-operator-secret'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let ownerId = ''

type SessionWire = { id: string; participants?: { id: string; userId: string }[] }

async function jsonOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

function sessionsPath(): string {
  return `/v1/organizations/${orgId}/remote-sessions`
}

function createSession(): Promise<Response> {
  return fetch(`${baseUrl}${sessionsPath()}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer owner',
      'content-type': 'application/json',
      'idempotency-key': randomUUID()
    },
    body: JSON.stringify({ kind: 'terminal', hostUserId: ownerId })
  })
}

function ownerParticipantId(session: SessionWire): string {
  const admin = session.participants?.find((p) => p.userId === ownerId)
  if (!admin) throw new Error('owner participant missing')
  return admin.id
}

// Issue a capability directly via the store so the test controls the nonce, audience, and expiry
// (issue time). This is the A2 authority the Relay later redeems through the internal endpoint.
async function issueDirect(input: {
  session: SessionWire
  capability: CapabilityKind
  audience: string
  nonce: string
  now?: Date
  ttlSeconds?: number
}): Promise<void> {
  const isControl = input.capability !== 'view'
  const result = await issueCapability(db, {
    organizationId: orgId,
    actorUserId: ownerId,
    sessionId: input.session.id,
    participantId: ownerParticipantId(input.session),
    capability: input.capability,
    audience: input.audience,
    now: input.now ?? new Date(),
    newNonce: input.nonce,
    ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    ...(isControl ? { requiresStepUp: true } : {})
  })
  expect(result.ok).toBe(true)
}

function relayAdmit(
  sessionId: string,
  body: Record<string, unknown>,
  operatorToken: string | null = OPERATOR_TOKEN
): Promise<Response> {
  return fetch(`${baseUrl}/internal/remote-sessions/${sessionId}/relay-admit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(operatorToken ? { authorization: `Bearer ${operatorToken}` } : {})
    },
    body: JSON.stringify(body)
  })
}

async function consumedAt(sessionId: string, nonce: string): Promise<Date | null | undefined> {
  const row = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('support.remote_session_capabilities')
      .select(['consumed_at'])
      .where('session_id', '=', sessionId)
      .where('nonce', '=', nonce)
      .executeTakeFirst()
  )
  return row?.consumed_at
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED relay-admit vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  app = buildApp({
    ping: async () => true,
    db,
    registry,
    tokenVerifier: createTestTokenVerifier(),
    operatorToken: OPERATOR_TOKEN
  })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `admit-${orgId.slice(0, 8)}`,
    displayName: 'RelayAdmit'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('relay-admit internal endpoint (R8 B2)', () => {
  it('(a) redeems a view capability → 200 {participantId, capability}, single-use', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession())
    const nonce = `n-${randomUUID()}`
    await issueDirect({ session, capability: 'view', audience: 'stream-a', nonce })

    const res = await relayAdmit(session.id, { nonce, audience: 'stream-a', organizationId: orgId })
    expect(res.status).toBe(200)
    const grant = await jsonOf<{ participantId: string; capability: string }>(res)
    expect(grant.capability).toBe('view')
    expect(grant.participantId).toBe(ownerParticipantId(session))
    expect(await consumedAt(session.id, nonce)).not.toBeNull()

    // Second redemption of the same nonce is rejected — single-use.
    const second = await relayAdmit(session.id, {
      nonce,
      audience: 'stream-a',
      organizationId: orgId
    })
    expect(second.status).toBe(409)
  })

  it('(b) redeems a terminal_control capability → 200 capability terminal_control', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession())
    const nonce = `n-${randomUUID()}`
    await issueDirect({ session, capability: 'terminal_control', audience: 'stream-b', nonce })
    const res = await relayAdmit(session.id, { nonce, audience: 'stream-b', organizationId: orgId })
    expect(res.status).toBe(200)
    const grant = await jsonOf<{ capability: string }>(res)
    expect(grant.capability).toBe('terminal_control')
  })

  it('a wrong operator token → 401 and does not consume the capability', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession())
    const nonce = `n-${randomUUID()}`
    await issueDirect({ session, capability: 'view', audience: 'stream-w', nonce })
    const res = await relayAdmit(
      session.id,
      { nonce, audience: 'stream-w', organizationId: orgId },
      'wrong-token'
    )
    expect(res.status).toBe(401)
    expect(await consumedAt(session.id, nonce)).toBeNull()
  })

  it('a missing operator token → 401', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession())
    const nonce = `n-${randomUUID()}`
    await issueDirect({ session, capability: 'view', audience: 'stream-m', nonce })
    const res = await relayAdmit(
      session.id,
      { nonce, audience: 'stream-m', organizationId: orgId },
      null
    )
    expect(res.status).toBe(401)
  })

  it('an expired capability → 410 Gone', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession())
    const nonce = `n-${randomUUID()}`
    // Issue in the past with a short ttl so expires_at is well before the endpoint's real clock.
    await issueDirect({
      session,
      capability: 'view',
      audience: 'stream-e',
      nonce,
      now: new Date(Date.now() - 600_000),
      ttlSeconds: 30
    })
    const res = await relayAdmit(session.id, { nonce, audience: 'stream-e', organizationId: orgId })
    expect(res.status).toBe(410)
  })

  it('an audience mismatch → 409', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession())
    const nonce = `n-${randomUUID()}`
    await issueDirect({ session, capability: 'view', audience: 'stream-real', nonce })
    const res = await relayAdmit(session.id, {
      nonce,
      audience: 'stream-other',
      organizationId: orgId
    })
    expect(res.status).toBe(409)
  })

  it('an unknown nonce → 409 invalid', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession())
    const res = await relayAdmit(session.id, {
      nonce: `n-${randomUUID()}`,
      audience: 'stream-x',
      organizationId: orgId
    })
    expect(res.status).toBe(409)
  })

  it('a mismatched organizationId cannot redeem another tenant capability (RLS) → 409', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession())
    const nonce = `n-${randomUUID()}`
    await issueDirect({ session, capability: 'view', audience: 'stream-rls', nonce })
    // The capability exists under orgId; a request naming a different org finds no row (RLS-scoped).
    const res = await relayAdmit(session.id, {
      nonce,
      audience: 'stream-rls',
      organizationId: randomUUID()
    })
    expect(res.status).toBe(409)
    expect(await consumedAt(session.id, nonce)).toBeNull()
  })
})
