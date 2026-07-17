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
  quarantineEventTx,
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

// OPS-001: poison isolation (progress-around-poison) + server-side quarantine (dead-letter) +
// operator visibility/recovery. A batch [valid, POISON, valid] must ingest both valid events
// while the poison is per-item rejected AND parked in the quarantine — metadata only (never the
// raw poison body). The list route surfaces it (RBAC + cross-tenant), and discard transitions it.

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

function quarantinePath(org = orgId): string {
  return `/v1/organizations/${org}/agent-event-quarantine`
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
  type?: string
  payload?: Record<string, unknown>
}

function envelope(o: EnvelopeOverrides): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: o.id ?? randomUUID(),
    source: 'urn:pie:client:installation',
    type: o.type ?? 'ai.pielab.agent.turn.streamed.v1',
    subject: 'agent-run',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    dataschema: 'https://schemas.pielab.ai/events/agent-event-envelope.v1.schema.json',
    pieorgid: orgId,
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
        turnId: null
      },
      producer: {
        type: 'hook',
        provider: 'claude_code',
        parserVersion: '1.0.0',
        trustDomain: 'client_observed'
      },
      assertion: 'observed',
      classification: 'internal',
      visibility: 'internal',
      payload: o.payload ?? { note: 'streamed' },
      capturedAt: new Date().toISOString()
    }
  }
}

// A structurally-valid envelope whose provenance TYPE demands a well-formed provenance payload but
// carries none → per-item PROVENANCE_INVALID (a poison that reaches the ingest loop).
function provenancePoison(o: {
  sessionId: string
  streamId: string
  sequence: number
}): Record<string, unknown> {
  return envelope({
    ...o,
    type: 'ai.pielab.agent.provenance.commit.v1',
    payload: { note: 'no provenance object here' }
  })
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
  streamId: string,
  idempotencyKey = randomUUID()
): Promise<Response> {
  return bearerFetch(token, batchPath(), {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: batchBody(events, streamId)
  })
}

type BatchResult = {
  results: { id: string; status: string; code?: string }[]
}

type QuarantineItem = {
  id: string
  eventId: string
  reasonCode: string
  status: string
  contentHash: string | null
  payloadSizeBytes: number
  version: number
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

async function countQuarantine(eventId: string): Promise<number> {
  const rows = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('execution.agent_event_quarantine')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('event_id', '=', eventId)
      .executeTakeFirstOrThrow()
  )
  return Number(rows.c)
}

async function listQuarantine(token: string): Promise<QuarantineItem[]> {
  const res = await bearerFetch(token, quarantinePath())
  expect(res.status).toBe(200)
  const page = await jsonOf<{ items: QuarantineItem[] }>(res)
  return page.items
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED agent-event quarantine vertical: Docker unavailable — ${String(error)}`)
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
  // organization_owner: has agent_event.ingest + agent_capture.manage (quarantine ops).
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // A plain member has agent_session.read but NOT agent_capture.manage → quarantine RBAC deny.
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

describe('agent-event quarantine vertical (OPS-001)', () => {
  it('(a) progress-around-poison: valid siblings ingest, the poison is rejected + quarantined (metadata only)', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const valid1 = envelope({ sessionId: session.id, streamId, sequence: 1 })
    const poison = provenancePoison({ sessionId: session.id, streamId, sequence: 2 })
    const valid2 = envelope({ sessionId: session.id, streamId, sequence: 3 })
    const res = await jsonOf<BatchResult>(await ingest('owner', [valid1, poison, valid2], streamId))
    const byId = new Map(res.results.map((r) => [r.id, r]))
    // Both valid events progressed AROUND the poison in the SAME batch.
    expect(byId.get(valid1.id as string)?.status).toBe('accepted')
    expect(byId.get(valid2.id as string)?.status).toBe('accepted')
    // The poison is per-item rejected, not stored.
    expect(byId.get(poison.id as string)?.status).toBe('permanent_rejected')
    expect(byId.get(poison.id as string)?.code).toBe('PROVENANCE_INVALID')
    expect(await countEvents(session.id)).toBe(2)
    // A quarantine row exists for the poison, carrying reason + metadata ONLY (hash + size), and
    // NO raw poison body is stored anywhere in the row.
    const items = await listQuarantine('owner')
    const record = items.find((i) => i.eventId === poison.id)
    expect(record).toBeDefined()
    expect(record?.reasonCode).toBe('provenance_invalid')
    expect(record?.status).toBe('quarantined')
    expect(record?.contentHash?.startsWith('sha256:')).toBe(true)
    expect(record?.payloadSizeBytes).toBeGreaterThan(0)
    // The metadata-only guarantee: the quarantine row schema has no payload/body column at all.
    const raw = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('execution.agent_event_quarantine')
        .selectAll()
        .where('event_id', '=', poison.id as string)
        .executeTakeFirstOrThrow()
    )
    expect(Object.keys(raw)).not.toContain('payload')
    expect(Object.keys(raw)).not.toContain('payload_object')
  })

  it('(b) an oversized event body is poison: rejected + quarantined as oversized, siblings commit', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const valid = envelope({ sessionId: session.id, streamId, sequence: 1 })
    // ~300KB body: under the envelope's maxProperties + Fastify body limit, over the 256KB cap.
    const oversized = envelope({
      sessionId: session.id,
      streamId,
      sequence: 2,
      payload: { blob: 'x'.repeat(300 * 1024) }
    })
    const res = await jsonOf<BatchResult>(await ingest('owner', [valid, oversized], streamId))
    const byId = new Map(res.results.map((r) => [r.id, r]))
    expect(byId.get(valid.id as string)?.status).toBe('accepted')
    expect(byId.get(oversized.id as string)?.status).toBe('permanent_rejected')
    expect(byId.get(oversized.id as string)?.code).toBe('PAYLOAD_OVERSIZED')
    expect(await countEvents(session.id)).toBe(1)
    const items = await listQuarantine('owner')
    const record = items.find((i) => i.eventId === oversized.id)
    expect(record?.reasonCode).toBe('oversized')
    expect(record?.payloadSizeBytes).toBeGreaterThan(256 * 1024)
  })

  it('(c) idempotent replay of the same poison batch does not double-quarantine', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const poison = provenancePoison({ sessionId: session.id, streamId, sequence: 1 })
    // Two separate batches (fresh idempotency keys) re-rejecting the SAME poison eventId.
    await ingest('owner', [poison], streamId)
    await ingest('owner', [poison], streamId)
    expect(await countQuarantine(poison.id as string)).toBe(1)
  })

  it('(d) RBAC + cross-tenant: a member is denied; another org cannot see this org quarantine', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    // A member without agent_capture.manage is denied the quarantine list.
    const denied = await bearerFetch('member', quarantinePath())
    expect(denied.status).toBe(403)
    // otherowner (not a member of orgId) is denied.
    const foreign = await bearerFetch('otherowner', quarantinePath())
    expect(foreign.status).toBe(403)
    // otherowner listing THEIR OWN (empty) org quarantine never sees this org's poison.
    const session = await createSession('owner')
    const streamId = randomUUID()
    const poison = provenancePoison({ sessionId: session.id, streamId, sequence: 1 })
    await ingest('owner', [poison], streamId)
    const otherRes = await bearerFetch('otherowner', quarantinePath(otherOrgId))
    expect(otherRes.status).toBe(200)
    const otherItems = (await jsonOf<{ items: QuarantineItem[] }>(otherRes)).items
    expect(otherItems.some((i) => i.eventId === poison.id)).toBe(false)
  })

  it('(e) discard transitions status + audits; a re-discard is terminal (409)', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const poison = provenancePoison({ sessionId: session.id, streamId, sequence: 1 })
    await ingest('owner', [poison], streamId)
    const record = (await listQuarantine('owner')).find((i) => i.eventId === poison.id)
    expect(record).toBeDefined()
    const discard = await bearerFetch('owner', `${quarantinePath()}/${record?.id}:discard`, {
      method: 'POST',
      headers: { 'if-match': `"agent-event-quarantine-${record?.version}"` }
    })
    expect(discard.status).toBe(200)
    const discarded = await jsonOf<QuarantineItem>(discard)
    expect(discarded.status).toBe('discarded')
    // The transition is audited.
    const audits = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('audit.audit_events')
        .select('action')
        .where('action', '=', 'agent_event.discarded')
        .where('target_id', '=', poison.id as string)
        .execute()
    )
    expect(audits.length).toBe(1)
    // A second discard on the now-terminal row is a 409 conflict.
    const again = await bearerFetch('owner', `${quarantinePath()}/${record?.id}:discard`, {
      method: 'POST',
      headers: { 'if-match': `"agent-event-quarantine-${discarded.version}"` }
    })
    expect(again.status).toBe(409)
  })

  it('(g) best-effort: a quarantine-write failure does not poison the batch transaction', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const goodEventId = randomUUID()
    // A bad quarantine write (a non-UUID event_id fails the DB cast) runs in a SAVEPOINT: it is
    // swallowed and MUST NOT abort the surrounding tx, so a later valid write still commits.
    await withTenantTransaction(db, orgId, async (trx) => {
      await quarantineEventTx(trx, orgId, null, {
        eventId: 'not-a-uuid',
        agentSessionId: randomUUID(),
        streamId: randomUUID(),
        sequence: 1,
        reasonCode: 'oversized',
        contentHash: 'sha256:deadbeef',
        payloadSizeBytes: 10
      })
      // The tx is still healthy after the isolated failure — this valid write commits.
      await quarantineEventTx(trx, orgId, null, {
        eventId: goodEventId,
        agentSessionId: randomUUID(),
        streamId: randomUUID(),
        sequence: 2,
        reasonCode: 'oversized',
        contentHash: 'sha256:cafe',
        payloadSizeBytes: 20
      })
    })
    expect(await countQuarantine(goodEventId)).toBe(1)
  })

  it('(f) discard requires If-Match (428 when absent)', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const poison = provenancePoison({ sessionId: session.id, streamId, sequence: 1 })
    await ingest('owner', [poison], streamId)
    const record = (await listQuarantine('owner')).find((i) => i.eventId === poison.id)
    const res = await bearerFetch('owner', `${quarantinePath()}/${record?.id}:discard`, {
      method: 'POST'
    })
    expect(res.status).toBe(428)
  })
})
