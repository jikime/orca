import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  grantDriver,
  joinParticipant,
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
let ownerId = '' // organization_owner: remote.view + remote.control org-wide (host/admin)
let operatorAId = '' // a second member, added as a control-capable operator
let operatorBId = '' // a third member, for handoff

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

function sessionsPath(): string {
  return `/v1/organizations/${orgId}/remote-sessions`
}

type SessionWire = {
  id: string
  status: string
  version: number
  participants?: { id: string; userId: string; grade: string; isDriver: boolean }[]
}

type DriverWire = {
  driver: {
    grantId: string
    operatorParticipantId: string
    operatorUserId: string
    approverUserId: string
    capabilityId: string | null
  } | null
}

function createSession(token: string): Promise<Response> {
  return bearerFetch(token, sessionsPath(), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ kind: 'terminal', hostUserId: ownerId })
  })
}

function ownerParticipantId(session: SessionWire): string {
  const admin = session.participants?.find((p) => p.userId === ownerId)
  if (!admin) throw new Error('owner participant missing')
  return admin.id
}

// Adds a roster participant via the store (bypasses the HTTP surface, which A2/A1 already cover).
async function addParticipant(sessionId: string, userId: string, grade: string): Promise<string> {
  const joined = await joinParticipant(db, {
    organizationId: orgId,
    sessionId,
    actorUserId: ownerId,
    userId,
    // grade is a store enum; the test only passes valid grades.
    grade: grade as 'observer' | 'terminal_control' | 'desktop_control' | 'admin'
  })
  if (!joined.ok) throw new Error(`join failed: ${joined.reason}`)
  return joined.participant.id
}

function grantDriverHttp(
  token: string,
  sessionId: string,
  body: Record<string, unknown>
): Promise<Response> {
  return bearerFetch(token, `${sessionsPath()}/${sessionId}/driver`, {
    method: 'PUT',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

function revokeDriverHttp(token: string, sessionId: string): Promise<Response> {
  return bearerFetch(token, `${sessionsPath()}/${sessionId}/driver`, {
    method: 'DELETE',
    headers: { 'idempotency-key': randomUUID() }
  })
}

async function auditEventTypes(sessionId: string): Promise<string[]> {
  const rows = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('support.remote_session_audit')
      .select('event_type')
      .where('session_id', '=', sessionId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
  )
  return rows.map((r) => r.event_type)
}

async function activeGrantCount(sessionId: string): Promise<number> {
  const { count } = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('support.remote_session_driver_grants')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('session_id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow()
  )
  return Number(count)
}

async function participantIsDriver(participantId: string): Promise<boolean> {
  const row = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('support.remote_session_participants')
      .select('is_driver')
      .where('id', '=', participantId)
      .executeTakeFirst()
  )
  return row?.is_driver === true
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED driver vertical: Docker unavailable — ${String(error)}`)
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
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `drv-${orgId.slice(0, 8)}`,
    displayName: 'Driver'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  operatorAId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'operator-a',
      roleIds: ['member']
    })
  ).userId
  operatorBId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'operator-b',
      roleIds: ['member']
    })
  ).userId
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('remote session driver vertical (R8 A3)', () => {
  it('(a) admin grants driver to an eligible operator → is_driver, grant row, audit', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const opId = await addParticipant(session.id, operatorAId, 'terminal_control')
    const res = await grantDriverHttp('owner', session.id, { operatorParticipantId: opId })
    expect(res.status).toBe(200)
    const wire = await jsonOf<DriverWire>(res)
    expect(wire.driver?.operatorParticipantId).toBe(opId)
    expect(wire.driver?.approverUserId).toBe(ownerId)
    expect(await participantIsDriver(opId)).toBe(true)
    expect(await activeGrantCount(session.id)).toBe(1)
    expect(await auditEventTypes(session.id)).toContain('driver_granted')
  })

  it('(b) handoff to a second operator → prior cleared, one active driver, both audited', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const opA = await addParticipant(session.id, operatorAId, 'terminal_control')
    const opB = await addParticipant(session.id, operatorBId, 'desktop_control')
    expect(
      (await grantDriverHttp('owner', session.id, { operatorParticipantId: opA })).status
    ).toBe(200)
    const handoff = await grantDriverHttp('owner', session.id, { operatorParticipantId: opB })
    expect(handoff.status).toBe(200)
    const wire = await jsonOf<DriverWire>(handoff)
    expect(wire.driver?.operatorParticipantId).toBe(opB)
    expect(await participantIsDriver(opA)).toBe(false)
    expect(await participantIsDriver(opB)).toBe(true)
    // The partial-unique index holds: exactly ONE active grant despite the handoff.
    expect(await activeGrantCount(session.id)).toBe(1)
    const events = await auditEventTypes(session.id)
    expect(events.filter((e) => e === 'driver_granted').length).toBe(2)
    expect(events).toContain('driver_revoked')
  })

  it('(c) self-grant (approver == operator) → 409 approver_is_operator', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    // The owner is an admin participant → control-capable, but is also the approver.
    const res = await grantDriverHttp('owner', session.id, {
      operatorParticipantId: ownerParticipantId(session)
    })
    expect(res.status).toBe(409)
  })

  it('(d) grant to an ineligible-grade (observer) operator → 422 operator_not_eligible', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const opId = await addParticipant(session.id, operatorAId, 'observer')
    const res = await grantDriverHttp('owner', session.id, { operatorParticipantId: opId })
    expect(res.status).toBe(422)
  })

  it('(e) a non-admin approver → 403 forbidden (store authority)', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const opId = await addParticipant(session.id, operatorAId, 'terminal_control')
    // operator-a is a plain member with no remote.control → resource gate denies before the store.
    const denied = await grantDriverHttp('operator-a', session.id, { operatorParticipantId: opId })
    expect(denied.status).toBe(403)
    // Store-level: even WITH the gate, a non-admin/non-host approver is forbidden. operatorB is a
    // control-capable participant but not an admin, so it may not grant.
    const opB = await addParticipant(session.id, operatorBId, 'terminal_control')
    const result = await grantDriver(db, {
      organizationId: orgId,
      approverUserId: operatorBId,
      sessionId: session.id,
      operatorParticipantId: opId,
      now: new Date()
    })
    expect(result).toEqual({ ok: false, reason: 'forbidden' })
    expect(opB).toBeDefined()
  })

  it('(f) revoke clears is_driver; a second revoke is an idempotent no-op', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const opId = await addParticipant(session.id, operatorAId, 'terminal_control')
    expect(
      (await grantDriverHttp('owner', session.id, { operatorParticipantId: opId })).status
    ).toBe(200)
    const revoke = await revokeDriverHttp('owner', session.id)
    expect(revoke.status).toBe(204)
    expect(await participantIsDriver(opId)).toBe(false)
    expect(await activeGrantCount(session.id)).toBe(0)
    // Idempotent: nothing left to revoke → still 204.
    const again = await revokeDriverHttp('owner', session.id)
    expect(again.status).toBe(204)
    expect(await auditEventTypes(session.id)).toContain('driver_revoked')
  })

  it('(g) ending the session revokes the active driver (applyTransition hook)', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const opId = await addParticipant(session.id, operatorAId, 'terminal_control')
    expect(
      (await grantDriverHttp('owner', session.id, { operatorParticipantId: opId })).status
    ).toBe(200)
    const ended = await bearerFetch('owner', `${sessionsPath()}/${session.id}:transition`, {
      method: 'POST',
      headers: {
        'if-match': `"remote-session-${session.version}"`,
        'idempotency-key': randomUUID()
      },
      body: JSON.stringify({ toStatus: 'ended' })
    })
    expect(ended.status).toBe(200)
    expect(await participantIsDriver(opId)).toBe(false)
    expect(await activeGrantCount(session.id)).toBe(0)
    const driver = await jsonOf<DriverWire>(
      await bearerFetch('owner', `${sessionsPath()}/${session.id}/driver`)
    )
    expect(driver.driver).toBeNull()
  })

  it('(h) grant on an ended session → 409 session_terminal', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const opId = await addParticipant(session.id, operatorAId, 'terminal_control')
    const ended = await bearerFetch('owner', `${sessionsPath()}/${session.id}:transition`, {
      method: 'POST',
      headers: {
        'if-match': `"remote-session-${session.version}"`,
        'idempotency-key': randomUUID()
      },
      body: JSON.stringify({ toStatus: 'ended' })
    })
    expect(ended.status).toBe(200)
    const res = await grantDriverHttp('owner', session.id, { operatorParticipantId: opId })
    expect(res.status).toBe(409)
  })

  it('store-level: the single-driver invariant holds across a direct handoff', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const opA = await addParticipant(session.id, operatorAId, 'terminal_control')
    const opB = await addParticipant(session.id, operatorBId, 'terminal_control')
    const first = await grantDriver(db, {
      organizationId: orgId,
      approverUserId: ownerId,
      sessionId: session.id,
      operatorParticipantId: opA,
      now: new Date()
    })
    expect(first.ok).toBe(true)
    const second = await grantDriver(db, {
      organizationId: orgId,
      approverUserId: ownerId,
      sessionId: session.id,
      operatorParticipantId: opB,
      capabilityId: randomUUID(),
      now: new Date()
    })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.driver.capabilityId).not.toBeNull()
    expect(await activeGrantCount(session.id)).toBe(1)
    expect(await participantIsDriver(opA)).toBe(false)
    expect(await participantIsDriver(opB)).toBe(true)
  })
})
