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

// R5 slice 5a: THE exit-condition proof — "내부 prompt와 제한 tool output이 고객 Evidence와 검색
// 결과에 노출되지 않는다" — plus capture-mode enforcement, default-deny, RBAC, and append-only.

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

type SessionWire = { id: string; version: number; captureMode: string }

async function createSession(token: string, captureMode?: string): Promise<SessionWire> {
  const res = await bearerFetch(token, sessionsPath(), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      provider: 'claude_code',
      hostId: randomUUID(),
      ...(captureMode ? { captureMode } : {})
    })
  })
  expect(res.status).toBe(201)
  return jsonOf<SessionWire>(res)
}

type EnvelopeOverrides = {
  id?: string
  sessionId: string
  streamId: string
  sequence: number
  turnId?: string | null
  type?: string
  visibility?: 'internal' | 'project' | 'customer'
  classification?: 'public' | 'internal' | 'project_confidential' | 'restricted'
  note?: string
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
        turnId: o.turnId ?? null
      },
      producer: {
        type: 'hook',
        provider: 'claude_code',
        parserVersion: '1.0.0',
        trustDomain: 'client_observed'
      },
      assertion: 'observed',
      classification: o.classification ?? 'internal',
      visibility: o.visibility ?? 'internal',
      payload: { note: o.note ?? 'streamed' },
      capturedAt: new Date().toISOString()
    }
  }
}

function ingest(
  token: string,
  events: Record<string, unknown>[],
  streamId: string
): Promise<Response> {
  return bearerFetch(token, batchPath(), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      batchId: randomUUID(),
      producerId: randomUUID(),
      protocolVersion: '1.0',
      events,
      clientCheckpoint: { streamId, lastServerAck: 0 }
    })
  })
}

type TimelineWire = {
  turns: { turnId: string; eventCount: number }[]
  events: { eventId: string; visibility: string; classification: string; type: string }[]
  captureGaps: { sequence: number; reason: string }[]
}
type EvidenceWire = {
  scope: string
  items: {
    eventId: string
    visibility: string
    classification: string
    redacted: boolean
    preview: string
  }[]
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED agent capture/visibility vertical: Docker unavailable — ${String(error)}`)
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
  // owner: has agent_turn.read_raw + agent_capture.manage → internal scope, may set capture policy.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // member: has agent_session.read but NOT read_raw / capture.manage → project-scoped, RBAC-denied.
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

// Builds the exit-condition session: an internal system-prompt turn, a restricted tool_output, a
// customer result artifact — each a distinct event with its own visibility/classification.
async function seedScopedSession(): Promise<SessionWire> {
  const session = await createSession('owner')
  const streamId = randomUUID()
  const promptTurn = randomUUID()
  await ingest(
    'owner',
    [
      envelope({
        sessionId: session.id,
        streamId,
        sequence: 1,
        turnId: promptTurn,
        type: 'ai.pielab.agent.turn.streamed.v1',
        visibility: 'internal',
        classification: 'internal',
        note: 'SYSTEM PROMPT internal-only guardrails'
      }),
      envelope({
        sessionId: session.id,
        streamId,
        sequence: 2,
        type: 'ai.pielab.agent.tool_output.streamed.v1',
        visibility: 'project',
        classification: 'restricted',
        note: 'TOOLSECRET api key sk-live-1234'
      }),
      envelope({
        sessionId: session.id,
        streamId,
        sequence: 3,
        turnId: randomUUID(),
        type: 'ai.pielab.agent.result.streamed.v1',
        visibility: 'customer',
        classification: 'public',
        note: 'CUSTOMER final delivery summary'
      })
    ],
    streamId
  )
  return session
}

describe('agent capture + visibility + redaction vertical (R5 s5a)', () => {
  it('(a) EXIT: customer-scoped timeline/evidence/search return ONLY the customer artifact', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await seedScopedSession()
    // Timeline at customer scope: only the customer event, internal prompt + restricted absent.
    const timeline = await jsonOf<TimelineWire>(
      await bearerFetch('owner', `${sessionsPath()}/${session.id}/timeline?scope=customer`)
    )
    expect(timeline.events).toHaveLength(1)
    expect(timeline.events[0]?.visibility).toBe('customer')
    expect(timeline.events.some((e) => e.visibility === 'internal')).toBe(false)
    expect(timeline.events.some((e) => e.classification === 'restricted')).toBe(false)
    // The internal-only system-prompt turn is absent (not just empty-counted).
    expect(timeline.turns).toHaveLength(1)

    // Evidence at customer scope: only the customer item; internal/restricted absent.
    const evidence = await jsonOf<EvidenceWire>(
      await bearerFetch('owner', `${sessionsPath()}/${session.id}/evidence?scope=customer`)
    )
    expect(evidence.scope).toBe('customer')
    expect(evidence.items).toHaveLength(1)
    expect(evidence.items[0]?.visibility).toBe('customer')
    expect(evidence.items[0]?.preview).toContain('CUSTOMER')

    // Search at customer scope for a term only in the restricted tool output → no leak in snippet
    // or count; the internal prompt term likewise absent.
    const secretHits = await jsonOf<EvidenceWire>(
      await bearerFetch(
        'owner',
        `${sessionsPath()}/${session.id}/evidence?scope=customer&q=TOOLSECRET`
      )
    )
    expect(secretHits.items).toHaveLength(0)
    const promptHits = await jsonOf<EvidenceWire>(
      await bearerFetch(
        'owner',
        `${sessionsPath()}/${session.id}/evidence?scope=customer&q=SYSTEM%20PROMPT`
      )
    )
    expect(promptHits.items).toHaveLength(0)
    // The customer term does match.
    const customerHits = await jsonOf<EvidenceWire>(
      await bearerFetch(
        'owner',
        `${sessionsPath()}/${session.id}/evidence?scope=customer&q=CUSTOMER`
      )
    )
    expect(customerHits.items).toHaveLength(1)
  })

  it('(b) internal scope sees more, but restricted (secret) payloads are redacted', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await seedScopedSession()
    // owner holds agent_turn.read_raw → internal scope with no param.
    const evidence = await jsonOf<EvidenceWire>(
      await bearerFetch('owner', `${sessionsPath()}/${session.id}/evidence`)
    )
    expect(evidence.scope).toBe('internal')
    expect(evidence.items).toHaveLength(3)
    const restricted = evidence.items.find((i) => i.classification === 'restricted')
    expect(restricted?.redacted).toBe(true)
    expect(restricted?.preview).toBe('‹redacted›')
    // The secret never appears even to an internal reader.
    expect(restricted?.preview).not.toContain('sk-live')
    // A search for the secret term never surfaces the redacted record, even at internal scope.
    const hits = await jsonOf<EvidenceWire>(
      await bearerFetch(
        'owner',
        `${sessionsPath()}/${session.id}/evidence?scope=internal&q=sk-live`
      )
    )
    expect(hits.items).toHaveLength(0)
    // The internal-visibility (non-restricted) event IS visible with its content at internal scope.
    const promptItem = evidence.items.find((i) => i.visibility === 'internal')
    expect(promptItem?.redacted).toBe(false)
    expect(promptItem?.preview).toContain('SYSTEM PROMPT')
  })

  it('(c) a member is clamped to project scope even when requesting internal', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await seedScopedSession()
    // member lacks agent_turn.read_raw → max scope project; requesting internal cannot widen.
    const evidence = await jsonOf<EvidenceWire>(
      await bearerFetch('member', `${sessionsPath()}/${session.id}/evidence?scope=internal`)
    )
    expect(evidence.scope).toBe('project')
    expect(evidence.items.some((i) => i.visibility === 'internal')).toBe(false)
    // The project-visibility restricted tool output is present but redacted.
    const restricted = evidence.items.find((i) => i.classification === 'restricted')
    expect(restricted?.redacted).toBe(true)
  })

  it('(d) capture_mode=metadata_only drops payload body but keeps envelope metadata', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner', 'metadata_only')
    const streamId = randomUUID()
    const turnId = randomUUID()
    await ingest(
      'owner',
      [
        envelope({
          sessionId: session.id,
          streamId,
          sequence: 1,
          turnId,
          visibility: 'customer',
          classification: 'public',
          note: 'RAWBODY should not be stored'
        })
      ],
      streamId
    )
    // The stored payload is stripped to {}; envelope metadata columns are kept.
    const row = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('execution.agent_events')
        .select(['payload', 'type', 'visibility', 'classification'])
        .where('agent_session_id', '=', session.id)
        .executeTakeFirstOrThrow()
    )
    expect(row.payload).toEqual({})
    expect(row.type).toBe('ai.pielab.agent.turn.streamed.v1')
    expect(row.visibility).toBe('customer')
    // Timeline still shows the turn (metadata kept).
    const timeline = await jsonOf<TimelineWire>(
      await bearerFetch('owner', `${sessionsPath()}/${session.id}/timeline?scope=customer`)
    )
    expect(timeline.turns).toHaveLength(1)
    // The raw body never appears in evidence.
    const evidence = await jsonOf<EvidenceWire>(
      await bearerFetch(
        'owner',
        `${sessionsPath()}/${session.id}/evidence?scope=customer&q=RAWBODY`
      )
    )
    expect(evidence.items).toHaveLength(0)
  })

  it('(e) capture_mode=paused writes a gap marker; timeline shows the gap, no false-complete', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner', 'paused')
    const streamId = randomUUID()
    const res = await jsonOf<{
      results: { status: string }[]
      streamAcks: { streamId: string; contiguousThrough: number; gaps: number[] }[]
    }>(
      await ingest(
        'owner',
        [
          envelope({ sessionId: session.id, streamId, sequence: 1, visibility: 'customer' }),
          envelope({ sessionId: session.id, streamId, sequence: 2, visibility: 'customer' })
        ],
        streamId
      )
    )
    expect(res.results.every((r) => r.status === 'accepted')).toBe(true)
    // No event rows were stored (paused drops the event).
    const eventCount = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('execution.agent_events')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('agent_session_id', '=', session.id)
        .executeTakeFirstOrThrow()
    )
    expect(Number(eventCount.c)).toBe(0)
    // The timeline shows explicit capture gaps (not a false-complete empty timeline).
    const timeline = await jsonOf<TimelineWire>(
      await bearerFetch('owner', `${sessionsPath()}/${session.id}/timeline?scope=customer`)
    )
    expect(timeline.events).toHaveLength(0)
    expect(timeline.turns).toHaveLength(0)
    expect(timeline.captureGaps).toHaveLength(2)
    expect(timeline.captureGaps.every((g) => g.reason === 'capture_paused')).toBe(true)
  })

  it('(f) idempotent paused replay does not double-mark the gap', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner', 'paused')
    const streamId = randomUUID()
    const eventId = randomUUID()
    const ev = envelope({
      id: eventId,
      sessionId: session.id,
      streamId,
      sequence: 1,
      visibility: 'customer'
    })
    await ingest('owner', [ev], streamId)
    const replay = await jsonOf<{ results: { status: string }[] }>(
      await ingest(
        'owner',
        [
          envelope({
            id: eventId,
            sessionId: session.id,
            streamId,
            sequence: 1,
            visibility: 'customer'
          })
        ],
        streamId
      )
    )
    expect(replay.results[0]?.status).toBe('duplicate')
    const gapCount = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('execution.agent_capture_gaps')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('agent_session_id', '=', session.id)
        .executeTakeFirstOrThrow()
    )
    expect(Number(gapCount.c)).toBe(1)
  })

  it('(g) default-deny: the CHECK forbids an out-of-vocabulary visibility from ever being stored', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    // An unknown visibility can never enter the append-only log — the read path can only ever see
    // one of the three known tiers, so it can never accidentally widen an unrecognized value.
    await expect(
      withTenantTransaction(db, orgId, (trx) =>
        trx
          .insertInto('execution.agent_events')
          .values({
            organization_id: orgId,
            event_id: randomUUID(),
            agent_session_id: session.id,
            stream_id: randomUUID(),
            sequence: 1,
            type: 'ai.pielab.agent.turn.streamed.v1',
            source_uri: 'urn:pie:client:installation',
            subject: 'agent-run',
            producer_id: randomUUID(),
            producer_type: 'hook',
            provider: 'claude_code',
            parser_version: '1.0.0',
            trust_domain: 'client_observed',
            assertion: 'observed',
            classification: 'internal',
            visibility: 'totally-unknown',
            occurred_at: new Date().toISOString(),
            captured_at: new Date().toISOString(),
            payload: JSON.stringify({ note: 'legacy' })
          })
          .execute()
      )
    ).rejects.toThrow()
  })

  it('(h) RBAC deny: a member without agent_capture.manage cannot set capture mode', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const denied = await bearerFetch('member', `${sessionsPath()}/${session.id}:set-capture-mode`, {
      method: 'POST',
      headers: {
        'if-match': `"agent-session-${session.version}"`,
        'idempotency-key': randomUUID()
      },
      body: JSON.stringify({ captureMode: 'paused' })
    })
    expect(denied.status).toBe(403)
    // authorization_denials recorded the capture-policy denial.
    const denials = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.authorization_denials')
        .select('permission')
        .where('permission', '=', 'agent_capture.manage')
        .where('requested_organization_id', '=', orgId)
        .execute()
    )
    expect(denials.length).toBeGreaterThan(0)
  })

  it('(i) owner sets capture mode with OCC + audit; stale If-Match is 409, missing is 428', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const missing = await bearerFetch('owner', `${sessionsPath()}/${session.id}:set-capture-mode`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ captureMode: 'metadata_only' })
    })
    expect(missing.status).toBe(428)
    const ok = await bearerFetch('owner', `${sessionsPath()}/${session.id}:set-capture-mode`, {
      method: 'POST',
      headers: {
        'if-match': `"agent-session-${session.version}"`,
        'idempotency-key': randomUUID()
      },
      body: JSON.stringify({ captureMode: 'metadata_only' })
    })
    expect(ok.status).toBe(200)
    expect((await jsonOf<SessionWire>(ok)).captureMode).toBe('metadata_only')
    // Re-using the now-stale version → 409.
    const stale = await bearerFetch('owner', `${sessionsPath()}/${session.id}:set-capture-mode`, {
      method: 'POST',
      headers: {
        'if-match': `"agent-session-${session.version}"`,
        'idempotency-key': randomUUID()
      },
      body: JSON.stringify({ captureMode: 'paused' })
    })
    expect(stale.status).toBe(409)
    const audits = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.audit_events')
        .select('action')
        .where('action', '=', 'agent_capture.session_capture_mode_set')
        .where('target_id', '=', session.id)
        .execute()
    )
    expect(audits.length).toBeGreaterThan(0)
  })

  it('(j) append-only preserved: redaction never mutates the stored event', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await seedScopedSession()
    // Read at customer scope (which redacts/excludes), then confirm the raw restricted payload is
    // still intact in the append-only store — redaction is on the read projection only.
    await bearerFetch('owner', `${sessionsPath()}/${session.id}/evidence?scope=customer&q=x`)
    const restricted = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('execution.agent_events')
        .select('payload')
        .where('agent_session_id', '=', session.id)
        .where('classification', '=', 'restricted')
        .executeTakeFirstOrThrow()
    )
    expect(JSON.stringify(restricted.payload)).toContain('sk-live-1234')
  })

  it('(k) cross-tenant isolation: another org cannot read evidence or set capture mode', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const read = await bearerFetch('otherowner', `${sessionsPath()}/${session.id}/evidence`)
    expect(read.status).toBe(403)
    const write = await bearerFetch(
      'otherowner',
      `${sessionsPath()}/${session.id}:set-capture-mode`,
      {
        method: 'POST',
        headers: {
          'if-match': `"agent-session-${session.version}"`,
          'idempotency-key': randomUUID()
        },
        body: JSON.stringify({ captureMode: 'paused' })
      }
    )
    expect(write.status).toBe(403)
  })
})
