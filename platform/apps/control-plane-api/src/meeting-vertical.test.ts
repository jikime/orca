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
let ownerId = '' // organization_owner: meeting.read + manage + minutes.review

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

function mt(org: string, suffix: string): string {
  return `/v1/organizations/${org}${suffix}`
}

type MeetingWire = {
  id: string
  status: string
  scopeKind: string
  scopeId: string | null
  version: number
}
type ParticipantWire = { id: string; userId: string; consentRecording: boolean; version: number }
type RecordingWire = {
  id: string
  status: string
  objectRef: string | null
  durationSeconds: number | null
  version: number
}
type MinutesWire = {
  id: string
  sourceType: string
  reviewStatus: string
  reviewedBy: string | null
  status: string
  version: number
}

async function createMeeting(token: string, body: Record<string, unknown>): Promise<MeetingWire> {
  const res = await bearerFetch(token, mt(orgId, '/meetings'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
  expect(res.status).toBe(201)
  return jsonOf<MeetingWire>(res)
}

async function addParticipant(
  token: string,
  meetingId: string,
  body: Record<string, unknown>
): Promise<ParticipantWire> {
  const res = await bearerFetch(token, mt(orgId, `/meetings/${meetingId}/participants`), {
    method: 'POST',
    body: JSON.stringify(body)
  })
  expect(res.status).toBe(201)
  return jsonOf<ParticipantWire>(res)
}

function consent(token: string, participantId: string, version: number): Promise<Response> {
  return bearerFetch(token, mt(orgId, `/meeting-participants/${participantId}:consent`), {
    method: 'POST',
    headers: { 'if-match': `"meeting-participant-${version}"` },
    body: JSON.stringify({ consent: true })
  })
}

function startRecording(token: string, meetingId: string): Promise<Response> {
  return bearerFetch(token, mt(orgId, `/meetings/${meetingId}/recordings`), { method: 'POST' })
}

function transition(
  token: string,
  meetingId: string,
  toStatus: string,
  version: number
): Promise<Response> {
  return bearerFetch(token, mt(orgId, `/meetings/${meetingId}:transition`), {
    method: 'POST',
    headers: { 'if-match': `"meeting-${version}"` },
    body: JSON.stringify({ toStatus })
  })
}

function createMinutes(
  token: string,
  meetingId: string,
  body: Record<string, unknown>
): Promise<Response> {
  return bearerFetch(token, mt(orgId, `/meetings/${meetingId}/minutes`), {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

function finalizeMinutes(token: string, minutesId: string, version: number): Promise<Response> {
  return bearerFetch(token, mt(orgId, `/meeting-minutes/${minutesId}:finalize`), {
    method: 'POST',
    headers: { 'if-match': `"meeting-minutes-${version}"` }
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED meeting vertical: Docker unavailable — ${String(error)}`)
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
    slug: `mt-${orgId.slice(0, 8)}`,
    displayName: 'MT'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `mt2-${otherOrgId.slice(0, 8)}`,
    displayName: 'MT2'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  // 'member' holds meeting.read only (no meeting.manage) — the RBAC-deny caller.
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

describe('meeting vertical (R7 meeting metadata plane — media plane deferred to infra)', () => {
  it('(a) CONSENT GATE: recording is refused until every joined participant consents, then finalizes', async (ctx) => {
    if (!harness) return ctx.skip()
    const meeting = await createMeeting('owner', { title: 'standup' })
    const p1 = await addParticipant('owner', meeting.id, { userId: randomUUID(), role: 'host' })
    const p2 = await addParticipant('owner', meeting.id, { userId: randomUUID() })
    expect(p1.consentRecording).toBe(false)
    expect(p2.consentRecording).toBe(false)

    // Neither consented → start recording refused with 422 CONSENT_REQUIRED.
    const refused = await startRecording('owner', meeting.id)
    expect(refused.status).toBe(422)
    expect((await jsonOf<{ code: string }>(refused)).code).toBe('CONSENT_REQUIRED')

    // Only p1 consents → still refused (p2 has not consented).
    const c1 = await jsonOf<ParticipantWire>(await consent('owner', p1.id, p1.version))
    expect(c1.consentRecording).toBe(true)
    const stillRefused = await startRecording('owner', meeting.id)
    expect(stillRefused.status).toBe(422)

    // p2 consents too → recording starts (pending).
    await consent('owner', p2.id, p2.version)
    const started = await startRecording('owner', meeting.id)
    expect(started.status).toBe(201)
    const recording = await jsonOf<RecordingWire>(started)
    expect(recording.status).toBe('pending')
    expect(recording.objectRef).toBeNull()

    // Finalize attaches the opaque object_ref + duration and marks it available (media upload is infra).
    const objectRef = randomUUID()
    const finalized = await bearerFetch(
      'owner',
      mt(orgId, `/meeting-recordings/${recording.id}:finalize`),
      {
        method: 'POST',
        headers: { 'if-match': `"meeting-recording-${recording.version}"` },
        body: JSON.stringify({ objectRef, durationSeconds: 742 })
      }
    )
    expect(finalized.status).toBe(200)
    const available = await jsonOf<RecordingWire>(finalized)
    expect(available.status).toBe('available')
    expect(available.objectRef).toBe(objectRef)
    expect(available.durationSeconds).toBe(742)
  })

  it('(b) CONTEXT PRESERVATION: a project-scoped ended meeting with minutes is retrievable via scope filter', async (ctx) => {
    if (!harness) return ctx.skip()
    const projectId = randomUUID()
    const meeting = await createMeeting('owner', {
      title: 'project kickoff',
      scopeKind: 'project',
      scopeId: projectId
    })
    expect(meeting.scopeKind).toBe('project')
    expect(meeting.scopeId).toBe(projectId)
    // Drive the meeting to ended: scheduled → live → ended.
    const live = await jsonOf<MeetingWire>(
      await transition('owner', meeting.id, 'live', meeting.version)
    )
    expect(live.status).toBe('live')
    const ended = await jsonOf<MeetingWire>(
      await transition('owner', meeting.id, 'ended', live.version)
    )
    expect(ended.status).toBe('ended')
    // Record the result: minutes preserved with the meeting.
    const minutesRes = await createMinutes('owner', meeting.id, {
      summary: '# Decisions\n- shipped',
      sourceType: 'manual'
    })
    expect(minutesRes.status).toBe(201)

    // The scope-filtered list returns the meeting — the project context retains it.
    const listRes = await bearerFetch(
      'owner',
      mt(orgId, `/meetings?scopeKind=project&scopeId=${projectId}`)
    )
    expect(listRes.status).toBe(200)
    const items = (await jsonOf<{ items: MeetingWire[] }>(listRes)).items
    expect(items.map((m) => m.id)).toContain(meeting.id)
    // A different project's scope filter does NOT return it.
    const otherList = await bearerFetch(
      'owner',
      mt(orgId, `/meetings?scopeKind=project&scopeId=${randomUUID()}`)
    )
    expect(
      (await jsonOf<{ items: MeetingWire[] }>(otherList)).items.map((m) => m.id)
    ).not.toContain(meeting.id)
  })

  it('(c) AI-MINUTES REVIEW: unreviewed AI minutes cannot finalize; approval unlocks; manual finalizes freely', async (ctx) => {
    if (!harness) return ctx.skip()
    const meeting = await createMeeting('owner', { title: 'retro' })
    const aiMinutes = await jsonOf<MinutesWire>(
      await createMinutes('owner', meeting.id, {
        summary: 'AI-generated summary',
        sourceType: 'ai'
      })
    )
    expect(aiMinutes.sourceType).toBe('ai')
    expect(aiMinutes.reviewStatus).toBe('unreviewed')

    // Finalize refused while the AI minutes are unreviewed → 422 MINUTES_REVIEW_REQUIRED.
    const refused = await finalizeMinutes('owner', aiMinutes.id, aiMinutes.version)
    expect(refused.status).toBe(422)
    expect((await jsonOf<{ code: string }>(refused)).code).toBe('MINUTES_REVIEW_REQUIRED')

    // A human reviewer approves (reviewer recorded), THEN finalize succeeds.
    const reviewed = await jsonOf<MinutesWire>(
      await bearerFetch('owner', mt(orgId, `/meeting-minutes/${aiMinutes.id}:review`), {
        method: 'POST',
        headers: { 'if-match': `"meeting-minutes-${aiMinutes.version}"` },
        body: JSON.stringify({ decision: 'approve' })
      })
    )
    expect(reviewed.reviewStatus).toBe('approved')
    expect(reviewed.reviewedBy).toBe(ownerId)
    const finalized = await jsonOf<MinutesWire>(
      await finalizeMinutes('owner', aiMinutes.id, reviewed.version)
    )
    expect(finalized.status).toBe('finalized')

    // Manual minutes finalize with NO review gate.
    const manual = await jsonOf<MinutesWire>(
      await createMinutes('owner', meeting.id, { summary: 'human notes', sourceType: 'manual' })
    )
    const manualFinal = await finalizeMinutes('owner', manual.id, manual.version)
    expect(manualFinal.status).toBe(200)
    expect((await jsonOf<MinutesWire>(manualFinal)).status).toBe('finalized')
  })

  it('(d) meeting :transition under OCC (200 / 409 stale / 428 no If-Match)', async (ctx) => {
    if (!harness) return ctx.skip()
    const meeting = await createMeeting('owner', { title: 'occ meeting' })
    // No If-Match → 428.
    const noIfMatch = await bearerFetch('owner', mt(orgId, `/meetings/${meeting.id}:transition`), {
      method: 'POST',
      body: JSON.stringify({ toStatus: 'live' })
    })
    expect(noIfMatch.status).toBe(428)
    // Correct version → 200.
    const ok = await jsonOf<MeetingWire>(
      await transition('owner', meeting.id, 'live', meeting.version)
    )
    expect(ok.status).toBe('live')
    // Stale version → 409.
    const stale = await transition('owner', meeting.id, 'ended', meeting.version)
    expect(stale.status).toBe(409)
  })

  it('(e) RBAC: a member without meeting.manage cannot create (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const denied = await bearerFetch('member', mt(orgId, '/meetings'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ title: 'x' })
    })
    expect(denied.status).toBe(403)
  })

  it('(f) cross-tenant: another org owner cannot read this org meeting (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const meeting = await createMeeting('owner', { title: 'tenant-bound' })
    const denied = await bearerFetch('other', mt(orgId, `/meetings/${meeting.id}`))
    expect(denied.status).toBe(403)
  })
})
