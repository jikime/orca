import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  createResourceGrant,
  issueCapability,
  joinParticipant,
  redeemCapability,
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
let subjectId = '' // the customer/consenter (a plain member)

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
  participants?: { id: string; userId: string; grade: string }[]
}

type TokenWire = {
  id: string
  nonce: string
  capability: string
  audience: string
  expiresAt: string
  requiresStepUp: boolean
}

function createSession(token: string): Promise<Response> {
  return bearerFetch(token, sessionsPath(), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ kind: 'terminal', hostUserId: ownerId })
  })
}

// The owner is the session admin participant on create — bind capabilities to that participant id.
function ownerParticipantId(session: SessionWire): string {
  const admin = session.participants?.find((p) => p.userId === ownerId)
  if (!admin) throw new Error('owner participant missing')
  return admin.id
}

function issueHttp(
  token: string,
  sessionId: string,
  body: Record<string, unknown>
): Promise<Response> {
  return bearerFetch(token, `${sessionsPath()}/${sessionId}/capabilities`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

function redeemHttp(
  token: string,
  sessionId: string,
  body: Record<string, unknown>
): Promise<Response> {
  return bearerFetch(token, `${sessionsPath()}/${sessionId}/capabilities:redeem`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
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

async function capabilityRow(
  sessionId: string,
  capabilityId: string
): Promise<{ consumed_at: Date | null; revoked_at: Date | null } | undefined> {
  return withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('support.remote_session_capabilities')
      .select(['consumed_at', 'revoked_at'])
      .where('session_id', '=', sessionId)
      .where('id', '=', capabilityId)
      .executeTakeFirst()
  )
}

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
    console.warn(`SKIPPED capability vertical: Docker unavailable — ${String(error)}`)
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
    slug: `cap-${orgId.slice(0, 8)}`,
    displayName: 'Capability'
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
  // A plain member with no remote.* permission — used only via its 'member' token for the gate test.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('remote session capability vertical (R8 A2)', () => {
  it('(a) admin issues a view capability → row + capability_issued audit', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const res = await issueHttp('owner', session.id, {
      participantId: ownerParticipantId(session),
      capability: 'view',
      audience: 'host:pty-a'
    })
    expect(res.status).toBe(201)
    const token = await jsonOf<TokenWire>(res)
    expect(token.capability).toBe('view')
    expect(token.requiresStepUp).toBe(false)
    expect(token.nonce.length).toBeGreaterThan(0)
    expect(await auditEventTypes(session.id)).toContain('capability_issued')
  })

  it('(b) a control capability with requiresStepUp=false → 422 step_up_required', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const res = await issueHttp('owner', session.id, {
      participantId: ownerParticipantId(session),
      capability: 'terminal_control',
      audience: 'host:pty-b',
      requiresStepUp: false
    })
    expect(res.status).toBe(422)
  })

  it('(c) redeem a valid capability → 200 granted, consumed_at set, audit', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const token = await jsonOf<TokenWire>(
      await issueHttp('owner', session.id, {
        participantId: ownerParticipantId(session),
        capability: 'terminal_control',
        audience: 'host:pty-c',
        requiresStepUp: true
      })
    )
    const redeemed = await redeemHttp('owner', session.id, {
      nonce: token.nonce,
      audience: 'host:pty-c'
    })
    expect(redeemed.status).toBe(200)
    const grant = await jsonOf<{ capability: string; participantId: string }>(redeemed)
    expect(grant.capability).toBe('terminal_control')
    expect((await capabilityRow(session.id, token.id))?.consumed_at).not.toBeNull()
    expect(await auditEventTypes(session.id)).toContain('capability_consumed')
  })

  it('(d) a second redeem of the same nonce → 409 already_consumed', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const token = await jsonOf<TokenWire>(
      await issueHttp('owner', session.id, {
        participantId: ownerParticipantId(session),
        capability: 'view',
        audience: 'host:pty-d'
      })
    )
    const first = await redeemHttp('owner', session.id, {
      nonce: token.nonce,
      audience: 'host:pty-d'
    })
    expect(first.status).toBe(200)
    const second = await redeemHttp('owner', session.id, {
      nonce: token.nonce,
      audience: 'host:pty-d'
    })
    expect(second.status).toBe(409)
  })

  it('(f) an audience mismatch on redeem → 409', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const token = await jsonOf<TokenWire>(
      await issueHttp('owner', session.id, {
        participantId: ownerParticipantId(session),
        capability: 'view',
        audience: 'host:pty-f'
      })
    )
    const res = await redeemHttp('owner', session.id, {
      nonce: token.nonce,
      audience: 'host:other'
    })
    expect(res.status).toBe(409)
  })

  it('(h) revoking consent revokes live capabilities and ends the session', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    await grantView(subjectId, session.id)
    const consent = await bearerFetch('subject', `${sessionsPath()}/${session.id}/consent`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({})
    })
    expect(consent.status).toBe(200)
    const token = await jsonOf<TokenWire>(
      await issueHttp('owner', session.id, {
        participantId: ownerParticipantId(session),
        capability: 'view',
        audience: 'host:pty-h'
      })
    )
    const revoked = await bearerFetch('subject', `${sessionsPath()}/${session.id}/consent`, {
      method: 'DELETE',
      headers: { 'idempotency-key': randomUUID() }
    })
    expect(revoked.status).toBe(204)
    // The session is ended and the capability is revoked → redemption now fails 409.
    const detail = await jsonOf<SessionWire>(
      await bearerFetch('owner', `${sessionsPath()}/${session.id}`)
    )
    expect(detail.status).toBe('ended')
    const redeem = await redeemHttp('owner', session.id, {
      nonce: token.nonce,
      audience: 'host:pty-h'
    })
    expect(redeem.status).toBe(409)
    expect(await auditEventTypes(session.id)).toContain('capability_revoked')
  })

  it('(i) issuing on an ended session → 409 session_terminal', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const ended = await bearerFetch('owner', `${sessionsPath()}/${session.id}:transition`, {
      method: 'POST',
      headers: {
        'if-match': `"remote-session-${session.version}"`,
        'idempotency-key': randomUUID()
      },
      body: JSON.stringify({ toStatus: 'ended' })
    })
    expect(ended.status).toBe(200)
    const res = await issueHttp('owner', session.id, {
      participantId: ownerParticipantId(session),
      capability: 'view',
      audience: 'host:pty-i'
    })
    expect(res.status).toBe(409)
  })

  it('a plain member without remote.control cannot issue (resource gate → 403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const denied = await issueHttp('member', session.id, {
      participantId: ownerParticipantId(session),
      capability: 'view',
      audience: 'host:pty-gate'
    })
    expect(denied.status).toBe(403)
  })

  it('(g) store-level: a non-admin/non-host participant cannot issue → forbidden', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    // subject joins as a non-admin (observer) participant.
    const joined = await joinParticipant(db, {
      organizationId: orgId,
      sessionId: session.id,
      actorUserId: ownerId,
      userId: subjectId,
      grade: 'observer'
    })
    expect(joined.ok).toBe(true)
    if (!joined.ok) return
    const result = await issueCapability(db, {
      organizationId: orgId,
      actorUserId: subjectId,
      sessionId: session.id,
      participantId: joined.participant.id,
      capability: 'view',
      audience: 'host:pty-g',
      now: new Date(),
      newNonce: randomUUID()
    })
    expect(result).toEqual({ ok: false, reason: 'forbidden' })
  })

  it('(e) store-level: an expired capability redeems as expired (injected now)', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const t0 = new Date('2026-07-16T10:00:00.000Z')
    const nonce = `nonce-${randomUUID()}`
    const issued = await issueCapability(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      sessionId: session.id,
      participantId: ownerParticipantId(session),
      capability: 'terminal_control',
      audience: 'host:pty-e',
      ttlSeconds: 30,
      requiresStepUp: true,
      now: t0,
      newNonce: nonce
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    // expires_at = t0 + 30s; redeem 100s later → expired.
    const expired = await redeemCapability(db, {
      organizationId: orgId,
      sessionId: session.id,
      nonce,
      audience: 'host:pty-e',
      now: new Date(t0.getTime() + 100_000)
    })
    expect(expired).toEqual({ ok: false, reason: 'expired' })
    // A within-window redeem of a FRESH capability succeeds (determinism of injected now).
    const nonce2 = `nonce-${randomUUID()}`
    const issued2 = await issueCapability(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      sessionId: session.id,
      participantId: ownerParticipantId(session),
      capability: 'view',
      audience: 'host:pty-e2',
      ttlSeconds: 300,
      now: t0,
      newNonce: nonce2
    })
    expect(issued2.ok).toBe(true)
    const ok = await redeemCapability(db, {
      organizationId: orgId,
      sessionId: session.id,
      nonce: nonce2,
      audience: 'host:pty-e2',
      now: new Date(t0.getTime() + 60_000)
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.grant.capability).toBe('view')
  })

  it('(ttl clamp) a ttl beyond the ceiling is clamped to the max, not rejected', async (ctx) => {
    if (!harness) return ctx.skip()
    const session = await jsonOf<SessionWire>(await createSession('owner'))
    const t0 = new Date('2026-07-16T11:00:00.000Z')
    const nonce = `nonce-${randomUUID()}`
    const issued = await issueCapability(db, {
      organizationId: orgId,
      actorUserId: ownerId,
      sessionId: session.id,
      participantId: ownerParticipantId(session),
      capability: 'view',
      audience: 'host:pty-clamp',
      ttlSeconds: 100_000,
      now: t0,
      newNonce: nonce
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    // Clamped to 300s: expiry is exactly t0 + 300s regardless of the huge request.
    expect(new Date(issued.capability.expiresAt).getTime()).toBe(t0.getTime() + 300_000)
  })
})
