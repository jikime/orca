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
  withoutTenantContext,
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

function sessionsPath(org = orgId): string {
  return `/v1/organizations/${org}/agent-sessions`
}

function batchPath(org = orgId): string {
  return `/v1/organizations/${org}/agent-events:batch`
}

async function createSession(token: string, org = orgId): Promise<{ id: string }> {
  const res = await bearerFetch(token, sessionsPath(org), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ provider: 'claude_code', hostId: randomUUID() })
  })
  expect(res.status).toBe(201)
  return jsonOf<{ id: string }>(res)
}

type EnvelopeOverrides = {
  id?: string
  sessionId: string
  streamId: string
  sequence: number
  turnId?: string | null
  assertion?: 'observed' | 'declared' | 'verified'
  contentHash?: string
  time?: string
  capturedAt?: string
  pieorgid?: string
  type?: string
}

function envelope(o: EnvelopeOverrides): Record<string, unknown> {
  const payload: Record<string, unknown> = { note: 'streamed' }
  if (o.contentHash) {
    payload.contentHash = o.contentHash
  }
  return {
    specversion: '1.0',
    id: o.id ?? randomUUID(),
    source: 'urn:pie:client:installation',
    type: o.type ?? 'ai.pielab.agent.turn.streamed.v1',
    subject: 'agent-run',
    time: o.time ?? new Date().toISOString(),
    datacontenttype: 'application/json',
    dataschema: 'https://schemas.pielab.ai/events/agent-event-envelope.v1.schema.json',
    pieorgid: o.pieorgid ?? orgId,
    piestream: o.streamId,
    piesequence: o.sequence,
    data: {
      context: {
        projectId: null,
        workItemId: null,
        workspaceId: null,
        hostId: randomUUID(),
        launchId: null,
        agentSessionId: o.sessionId,
        agentRunId: null,
        turnId: o.turnId ?? null
      },
      producer: {
        type: 'hook',
        provider: 'claude_code',
        parserVersion: '1.0.0',
        trustDomain: 'client_observed'
      },
      assertion: o.assertion ?? 'observed',
      classification: 'internal',
      visibility: 'internal',
      payload,
      capturedAt: o.capturedAt ?? new Date().toISOString()
    }
  }
}

function batchBody(events: Record<string, unknown>[], streamId: string): string {
  return JSON.stringify({
    batchId: randomUUID(),
    producerId: randomUUID(),
    protocolVersion: '1.0',
    events,
    clientCheckpoint: { streamId, lastServerAck: 0 }
  })
}

function ingest(
  token: string,
  events: Record<string, unknown>[],
  streamId: string
): Promise<Response> {
  return bearerFetch(token, batchPath(), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: batchBody(events, streamId)
  })
}

type BatchResult = {
  batchId: string
  results: { id: string; status: string; code?: string }[]
  streamAcks: { streamId: string; contiguousThrough: number; gaps: number[] }[]
}

async function countEvents(sessionId: string): Promise<number> {
  const rows = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('execution.agent_events')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('agent_session_id', '=', sessionId)
      .executeTakeFirstOrThrow()
  )
  return Number(rows.c)
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED agent-event ingest vertical: Docker unavailable — ${String(error)}`)
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
    slug: `ai-${orgId.slice(0, 8)}`,
    displayName: 'AI'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `other-${otherOrgId.slice(0, 8)}`,
    displayName: 'Other'
  })
  // organization_owner: has agent_event.ingest + agent_session.read.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // A plain member (has agent_session.read but NOT agent_event.ingest) for the RBAC deny path.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
  await seedMembershipFixture(db, {
    organizationId: otherOrgId,
    issuer: TEST_ISSUER,
    subject: 'otherowner',
    roleIds: ['organization_owner']
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('agent-event ingest + timeline vertical (R5 s1)', () => {
  it('(a) idempotent replay of the same eventId → no duplicate event and no duplicate turn', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const turnId = randomUUID()
    const eventId = randomUUID()
    const ev = envelope({ id: eventId, sessionId: session.id, streamId, sequence: 1, turnId })
    const first = await jsonOf<BatchResult>(await ingest('owner', [ev], streamId))
    expect(first.results[0]?.status).toBe('accepted')
    // Replay the identical event (fresh batch id) → duplicate, never a second insert.
    const replay = await jsonOf<BatchResult>(
      await ingest(
        'owner',
        [envelope({ id: eventId, sessionId: session.id, streamId, sequence: 1, turnId })],
        streamId
      )
    )
    expect(replay.results[0]?.status).toBe('duplicate')
    expect(await countEvents(session.id)).toBe(1)
    const timeline = await jsonOf<{ turns: { turnId: string; eventCount: number }[] }>(
      await bearerFetch('owner', `${sessionsPath()}/${session.id}/timeline`)
    )
    expect(timeline.turns).toHaveLength(1)
    expect(timeline.turns[0]?.eventCount).toBe(1)
  })

  it('(b) a provisional turn finalizes to an immutable revision when contentHash is confirmed', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const turnId = randomUUID()
    await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 1, turnId })],
      streamId
    )
    let timeline = await jsonOf<{
      turns: { status: string; revision: number; contentHash: string | null }[]
    }>(await bearerFetch('owner', `${sessionsPath()}/${session.id}/timeline`))
    expect(timeline.turns[0]?.status).toBe('provisional')
    expect(timeline.turns[0]?.contentHash).toBeNull()
    // A confirmed content hash from an observed event finalizes the turn (immutable revision).
    await ingest(
      'owner',
      [
        envelope({
          sessionId: session.id,
          streamId,
          sequence: 2,
          turnId,
          contentHash: 'sha256:abc'
        })
      ],
      streamId
    )
    timeline = await jsonOf(await bearerFetch('owner', `${sessionsPath()}/${session.id}/timeline`))
    expect(timeline.turns[0]?.status).toBe('finalized')
    expect(timeline.turns[0]?.revision).toBe(1)
    expect(timeline.turns[0]?.contentHash).toBe('sha256:abc')
  })

  it('(c) a per-stream sequence gap is detected and reported', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const res = await jsonOf<BatchResult>(
      await ingest(
        'owner',
        [
          envelope({ sessionId: session.id, streamId, sequence: 1 }),
          envelope({ sessionId: session.id, streamId, sequence: 2 }),
          envelope({ sessionId: session.id, streamId, sequence: 4 })
        ],
        streamId
      )
    )
    const ack = res.streamAcks.find((a) => a.streamId === streamId)
    expect(ack?.contiguousThrough).toBe(2)
    expect(ack?.gaps).toEqual([3])
  })

  it('(d) occurred≠received and ordering uses sequence not client time', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    // Feed OUT OF ORDER by capturedAt: seq 1 captured LATER, seq 2 captured EARLIER.
    const later = '2026-07-16T10:00:05.000Z'
    const earlier = '2026-07-16T10:00:01.000Z'
    const occurred = '2020-01-01T00:00:00.000Z'
    await ingest(
      'owner',
      [
        envelope({
          sessionId: session.id,
          streamId,
          sequence: 2,
          capturedAt: earlier,
          time: occurred
        }),
        envelope({
          sessionId: session.id,
          streamId,
          sequence: 1,
          capturedAt: later,
          time: occurred
        })
      ],
      streamId
    )
    const timeline = await jsonOf<{
      events: { sequence: number; occurredAt: string; receivedAt: string }[]
    }>(await bearerFetch('owner', `${sessionsPath()}/${session.id}/timeline`))
    // Stream order is by SEQUENCE, not the client capturedAt order we sent.
    expect(timeline.events.map((e) => e.sequence)).toEqual([1, 2])
    // received_at is server-stamped and distinct from the (far past) occurredAt.
    expect(timeline.events[0]?.occurredAt).toBe(occurred)
    expect(timeline.events[0]?.receivedAt).not.toBe(occurred)
  })

  it('(e) source/assertion round-trip; a declared event is not promoted to observed', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const turnId = randomUUID()
    // A declared event WITH a contentHash must NOT finalize the turn (declared is not evidence).
    await ingest(
      'owner',
      [
        envelope({
          sessionId: session.id,
          streamId,
          sequence: 1,
          turnId,
          assertion: 'declared',
          contentHash: 'sha256:xyz'
        })
      ],
      streamId
    )
    const timeline = await jsonOf<{
      turns: { status: string; contentHash: string | null }[]
      events: { assertion: string; producerType: string; trustDomain: string }[]
    }>(await bearerFetch('owner', `${sessionsPath()}/${session.id}/timeline`))
    expect(timeline.turns[0]?.status).toBe('provisional')
    expect(timeline.turns[0]?.contentHash).toBeNull()
    expect(timeline.events[0]?.assertion).toBe('declared')
    expect(timeline.events[0]?.producerType).toBe('hook')
    expect(timeline.events[0]?.trustDomain).toBe('client_observed')
  })

  it('(f) cross-tenant isolation: another org cannot read or ingest', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    // otherowner is not a member of orgId → 403 on both read and ingest.
    const read = await bearerFetch('otherowner', `${sessionsPath()}/${session.id}/timeline`)
    expect(read.status).toBe(403)
    const write = await ingest(
      'otherowner',
      [envelope({ sessionId: session.id, streamId: randomUUID(), sequence: 1 })],
      randomUUID()
    )
    expect(write.status).toBe(403)
    // An event referencing a session that does not exist in THIS org is permanently rejected.
    const foreign = await jsonOf<BatchResult>(
      await ingest(
        'owner',
        [envelope({ sessionId: randomUUID(), streamId: randomUUID(), sequence: 1 })],
        randomUUID()
      )
    )
    expect(foreign.results[0]?.status).toBe('permanent_rejected')
    expect(foreign.results[0]?.code).toBe('SESSION_NOT_FOUND')
  })

  it('(g) append-only: an UPDATE or DELETE by the app role fails', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    await ingest('owner', [envelope({ sessionId: session.id, streamId, sequence: 1 })], streamId)
    await expect(
      withTenantTransaction(db, orgId, (trx) =>
        trx
          .updateTable('execution.agent_events')
          .set({ type: 'tampered' })
          .where('agent_session_id', '=', session.id)
          .execute()
      )
    ).rejects.toThrow()
    await expect(
      withTenantTransaction(db, orgId, (trx) =>
        trx
          .deleteFrom('execution.agent_events')
          .where('agent_session_id', '=', session.id)
          .execute()
      )
    ).rejects.toThrow()
  })

  it('(h) RBAC deny: a member without agent_event.ingest gets 403 + audit', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const denied = await ingest(
      'member',
      [envelope({ sessionId: session.id, streamId: randomUUID(), sequence: 1 })],
      randomUUID()
    )
    expect(denied.status).toBe(403)
    // The member CAN still read the timeline (agent_session.read).
    const read = await bearerFetch('member', `${sessionsPath()}/${session.id}/timeline`)
    expect(read.status).toBe(200)
    // authorization_denials is FORCE-RLS with no pie_app grant; read it as the privileged role.
    const denials = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.authorization_denials')
        .select('permission')
        .where('permission', '=', 'agent_event.ingest')
        .where('requested_organization_id', '=', orgId)
        .execute()
    )
    expect(denials.length).toBeGreaterThan(0)
  })

  it('(i) an anti-forgery batch whose event claims another org is rejected 400', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const forged = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 1, pieorgid: otherOrgId })],
      streamId
    )
    expect(forged.status).toBe(400)
  })
})
