import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  createResourceGrant,
  isLegalRemoteSessionTransition,
  joinParticipant,
  REMOTE_SESSION_TRANSITIONS,
  runMigrations,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  seedEntitlementManifest,
  updateParticipantGrade,
  withTenantTransaction,
  type PieDatabase,
  type RemoteSessionStatus
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
let ownerId = '' // organization_owner: has remote.view + remote.control org-wide (host/admin)
let subjectId = '' // the customer/consenter (a plain member)
let memberId = '' // a plain member with NO remote.* permission and NO grant

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
  status: RemoteSessionStatus
  version: number
  participants?: { id: string; userId: string; grade: string }[]
  latestConsent?: { subjectUserId: string; revokedAt: string | null } | null
}

function createSession(token: string): Promise<Response> {
  return bearerFetch(token, sessionsPath(), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ kind: 'terminal', hostUserId: ownerId })
  })
}

function transition(
  token: string,
  sessionId: string,
  version: number,
  toStatus: RemoteSessionStatus
): Promise<Response> {
  return bearerFetch(token, `${sessionsPath()}/${sessionId}:transition`, {
    method: 'POST',
    headers: { 'if-match': `"remote-session-${version}"`, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ toStatus })
  })
}

// Audit rows for a session, read from the org tenant context (RLS-safe).
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

// Grant the customer subject resource-scoped remote.view so they can act on consent.
async function grantView(userId: string, sessionId: string): Promise<void> {
  await createResourceGrant(db, {
    organizationId: orgId,
    userId,
    resourceType: 'remote_session',
    resourceId: sessionId,
    grantKind: 'widen',
    permission: 'remote.view'
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED remote-session vertical: Docker unavailable — ${String(error)}`)
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
    slug: `remote-${orgId.slice(0, 8)}`,
    displayName: 'Remote'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  subjectId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'subject',
      roleIds: ['member']
    })
  ).userId
  memberId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'member',
      roleIds: ['member']
    })
  ).userId
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('remote session vertical (R8 A1)', () => {
  it('(a) create → requested, creator is an admin participant, audit written', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await createSession('owner')
    expect(created.status).toBe(201)
    const session = await jsonOf<SessionWire>(created)
    expect(session.status).toBe('requested')
    expect(session.version).toBe(1)
    const admin = session.participants?.find((p) => p.userId === ownerId)
    expect(admin?.grade).toBe('admin')
    // Both rows share the tx timestamp, so assert membership not order.
    expect(await auditEventTypes(session.id)).toEqual(
      expect.arrayContaining(['session_created', 'participant_joined'])
    )
  })

  it('(b) legal transition chain with OCC version bumps + audit', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    // Consent must exist before connecting (doc 07 ties 연결중 to 고객 동의).
    await grantView(subjectId, session.id)
    const consent = await bearerFetch('subject', `${sessionsPath()}/${session.id}/consent`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({})
    })
    expect(consent.status).toBe(200)

    let version = session.version
    for (const step of ['awaiting_consent', 'connecting', 'active', 'paused', 'active', 'ended']) {
      const res = await transition('owner', session.id, version, step as RemoteSessionStatus)
      expect(res.status).toBe(200)
      const body = await jsonOf<SessionWire>(res)
      expect(body.status).toBe(step)
      expect(body.version).toBe(version + 1)
      version = body.version
    }
    const events = await auditEventTypes(session.id)
    expect(events.filter((e) => e === 'state_changed').length).toBe(6)
  })

  it('(c) an illegal transition (ended→active) is rejected 409', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    // requested → ended is legal (emergency stop); ended → active is not.
    const ended = await transition('owner', session.id, session.version, 'ended')
    expect(ended.status).toBe(200)
    const endedBody = await jsonOf<SessionWire>(ended)
    const illegal = await transition('owner', session.id, endedBody.version, 'active')
    expect(illegal.status).toBe(409)
  })

  it('(d) a stale If-Match → 409 conflict', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const ok = await transition('owner', session.id, session.version, 'awaiting_consent')
    expect(ok.status).toBe(200)
    // Reuse the now-stale original version.
    const stale = await transition('owner', session.id, session.version, 'ended')
    expect(stale.status).toBe(409)
  })

  it('(d2) missing If-Match → 428', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const res = await bearerFetch('subject', `${sessionsPath()}/${session.id}:transition`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ toStatus: 'awaiting_consent' })
    })
    // subject lacks remote.control → resource gate denies first (403). Use owner to hit 428.
    expect(res.status).toBe(403)
    const owner = await bearerFetch('owner', `${sessionsPath()}/${session.id}:transition`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ toStatus: 'awaiting_consent' })
    })
    expect(owner.status).toBe(428)
  })

  it('(e) a member without remote.control cannot transition (resource gate → 403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const denied = await transition('member', session.id, session.version, 'awaiting_consent')
    expect(denied.status).toBe(403)
  })

  it('(f) consent grant then revoke writes audit and forces the session to ended', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    await grantView(subjectId, session.id)
    const granted = await bearerFetch('subject', `${sessionsPath()}/${session.id}/consent`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({})
    })
    expect(granted.status).toBe(200)
    const revoked = await bearerFetch('subject', `${sessionsPath()}/${session.id}/consent`, {
      method: 'DELETE',
      headers: { 'idempotency-key': randomUUID() }
    })
    expect(revoked.status).toBe(204)
    // The session is now ended, and the latest consent shows revoked.
    const detail = await jsonOf<SessionWire>(
      await bearerFetch('owner', `${sessionsPath()}/${session.id}`)
    )
    expect(detail.status).toBe('ended')
    expect(detail.latestConsent?.revokedAt).not.toBeNull()
    const events = await auditEventTypes(session.id)
    expect(events).toContain('consent_granted')
    expect(events).toContain('consent_revoked')
    expect(events).toContain('state_changed')
  })

  it('(g) participant join / grade-change / leave roster + audit', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const added = await bearerFetch('owner', `${sessionsPath()}/${session.id}/participants`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ userId: memberId, grade: 'observer' })
    })
    expect(added.status).toBe(201)
    const participant = await jsonOf<{ id: string; grade: string }>(added)
    expect(participant.grade).toBe('observer')
    const patched = await bearerFetch(
      'owner',
      `${sessionsPath()}/${session.id}/participants/${participant.id}`,
      {
        method: 'PATCH',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ grade: 'terminal_control' })
      }
    )
    expect(patched.status).toBe(200)
    expect((await jsonOf<{ grade: string }>(patched)).grade).toBe('terminal_control')
    const left = await bearerFetch(
      'owner',
      `${sessionsPath()}/${session.id}/participants/${participant.id}`,
      { method: 'DELETE', headers: { 'idempotency-key': randomUUID() } }
    )
    expect(left.status).toBe(204)
    const events = await auditEventTypes(session.id)
    expect(events).toContain('grade_changed')
    expect(events).toContain('participant_left')
  })

  it('(h) resource-gated read: a member without a grant cannot GET the session', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const denied = await bearerFetch('member', `${sessionsPath()}/${session.id}`)
    expect(denied.status).toBe(403)
    // A widen grant on THIS session lets the same member read it.
    await grantView(memberId, session.id)
    const allowed = await bearerFetch('member', `${sessionsPath()}/${session.id}`)
    expect(allowed.status).toBe(200)
  })

  it('store-level: transition legality table matches the doc 07 state machine', (ctx) => {
    if (!harness) return ctx.skip()
    expect(isLegalRemoteSessionTransition('requested', 'awaiting_consent')).toBe(true)
    expect(isLegalRemoteSessionTransition('awaiting_consent', 'connecting')).toBe(true)
    expect(isLegalRemoteSessionTransition('active', 'paused')).toBe(true)
    expect(isLegalRemoteSessionTransition('paused', 'active')).toBe(true)
    expect(isLegalRemoteSessionTransition('active', 'ended')).toBe(true)
    expect(isLegalRemoteSessionTransition('ended', 'reviewed')).toBe(true)
    // Illegal / terminal edges.
    expect(isLegalRemoteSessionTransition('ended', 'active')).toBe(false)
    expect(isLegalRemoteSessionTransition('reviewed', 'active')).toBe(false)
    expect(isLegalRemoteSessionTransition('requested', 'active')).toBe(false)
    expect(REMOTE_SESSION_TRANSITIONS.reviewed).toEqual([])
  })

  it('store-level: a non-admin participant cannot change another grade (roster authority)', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    // Add the subject as a non-admin (observer) and the member as observer.
    const asSubject = await joinParticipant(db, {
      organizationId: orgId,
      sessionId: session.id,
      actorUserId: ownerId,
      userId: subjectId,
      grade: 'observer'
    })
    expect(asSubject.ok).toBe(true)
    const asMember = await joinParticipant(db, {
      organizationId: orgId,
      sessionId: session.id,
      actorUserId: ownerId,
      userId: memberId,
      grade: 'observer'
    })
    expect(asMember.ok).toBe(true)
    if (!asMember.ok) return
    // subject (a non-admin participant) tries to promote member → rejected by roster authority.
    const denied = await updateParticipantGrade(db, {
      organizationId: orgId,
      sessionId: session.id,
      actorUserId: subjectId,
      participantId: asMember.participant.id,
      grade: 'admin'
    })
    expect(denied).toEqual({ ok: false, reason: 'forbidden' })
  })
})
