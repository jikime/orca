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

type SessionWire = {
  id: string
  hostId: string
  provider: string
  workItemId: string | null
}

async function createSession(
  token: string,
  opts: { hostId?: string; provider?: string; workItemId?: string } = {}
): Promise<SessionWire> {
  const res = await bearerFetch(token, `/v1/organizations/${orgId}/agent-sessions`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      provider: opts.provider ?? 'claude_code',
      hostId: opts.hostId ?? randomUUID(),
      ...(opts.workItemId ? { workItemId: opts.workItemId } : {})
    })
  })
  expect(res.status).toBe(201)
  return jsonOf<SessionWire>(res)
}

// A minimal (non-provenance) streamed agent event for a session; drives the ingest-path intake
// hook. provider must match the session (claude_code) or the event is rejected.
function envelope(sessionId: string, streamId: string, seq: number, workspaceId: string | null) {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: 'urn:pie:client:installation',
    type: 'ai.pielab.agent.turn.streamed.v1',
    subject: 'agent-run',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    dataschema: 'https://schemas.pielab.ai/events/agent-event-envelope.v1.schema.json',
    pieorgid: orgId,
    piestream: streamId,
    piesequence: seq,
    data: {
      context: {
        projectId: null,
        workItemId: null,
        workspaceId,
        hostId: randomUUID(),
        launchId: null,
        agentSessionId: sessionId,
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
      payload: { note: 'streamed' },
      capturedAt: new Date().toISOString()
    }
  }
}

async function ingest(
  token: string,
  sessionId: string,
  streamId: string,
  seq: number,
  workspaceId: string | null = null
): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/agent-events:batch`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      batchId: randomUUID(),
      producerId: randomUUID(),
      protocolVersion: '1.0',
      events: [envelope(sessionId, streamId, seq, workspaceId)],
      clientCheckpoint: { streamId, lastServerAck: 0 }
    })
  })
}

type IntakeItem = {
  id: string
  agentSessionId: string
  status: string
  detectedReason: string
  hostId: string
  provider: string
  workspaceId: string | null
  workItemId: string | null
  assignedBy: string | null
  version: number
}

function listIntake(token: string, query = ''): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/agent-session-intake${query}`)
}

function assign(
  token: string,
  intakeId: string,
  workItemId: string,
  ifMatch: string | null
): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/agent-session-intake/${intakeId}:assign`, {
    method: 'POST',
    headers: {
      'idempotency-key': randomUUID(),
      ...(ifMatch ? { 'if-match': ifMatch } : {})
    },
    body: JSON.stringify({ workItemId })
  })
}

function reclassify(
  token: string,
  intakeId: string,
  body: Record<string, unknown>,
  ifMatch: string | null
): Promise<Response> {
  return bearerFetch(
    token,
    `/v1/organizations/${orgId}/agent-session-intake/${intakeId}:reclassify`,
    {
      method: 'POST',
      headers: {
        'idempotency-key': randomUUID(),
        ...(ifMatch ? { 'if-match': ifMatch } : {})
      },
      body: JSON.stringify(body)
    }
  )
}

// Direct DB reads for precise (non-API) assertions.
async function intakeRowsFor(sessionId: string): Promise<IntakeItem[]> {
  const rows = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('execution.agent_session_intake')
      .selectAll()
      .where('agent_session_id', '=', sessionId)
      .execute()
  )
  return rows.map((r) => ({
    id: r.id,
    agentSessionId: r.agent_session_id,
    status: r.status,
    detectedReason: r.detected_reason,
    hostId: r.host_id,
    provider: r.provider,
    workspaceId: r.workspace_id,
    workItemId: r.work_item_id,
    assignedBy: r.assigned_by,
    version: Number(r.version)
  }))
}

async function sessionWorkItem(sessionId: string): Promise<string | null> {
  const row = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('execution.agent_sessions')
      .select('work_item_id')
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow()
  )
  return row.work_item_id
}

async function auditActions(intakeId: string): Promise<string[]> {
  const rows = await withoutTenantContext(db, (trx) =>
    trx
      .selectFrom('audit.audit_events')
      .select('action')
      .where('organization_id', '=', orgId)
      .where('target_id', '=', intakeId)
      .execute()
  )
  return rows.map((r) => r.action)
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED agent-session-intake vertical: Docker unavailable — ${String(error)}`)
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
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  // A plain member has agent_session.read (can view the queue) but NOT agent_session.assign.
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

describe('agent-session-intake queue + assign/reclassify vertical (R5 s4b)', () => {
  it('(a) a session with no work_item → exactly one pending intake; replayed events do not duplicate', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    // CAP-001: the unbound session is NOT auto-attached to any project.
    expect(await sessionWorkItem(session.id)).toBeNull()
    let rows = await intakeRowsFor(session.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('pending')
    expect(rows[0]?.detectedReason).toBe('no_work_item')

    // Multiple ingested events across batches must NOT create additional intake rows (idempotent).
    const streamId = randomUUID()
    expect((await ingest('owner', session.id, streamId, 1)).status).toBe(200)
    expect((await ingest('owner', session.id, streamId, 2)).status).toBe(200)
    rows = await intakeRowsFor(session.id)
    expect(rows).toHaveLength(1)

    // It is visible in the pending queue until explicitly assigned.
    const page = await jsonOf<{ items: IntakeItem[] }>(await listIntake('owner'))
    expect(page.items.some((i) => i.agentSessionId === session.id && i.status === 'pending')).toBe(
      true
    )
  })

  it('(b) CAP-001 negative: a session created WITH a work_item is bound, never queued', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const workItemId = randomUUID()
    const session = await createSession('owner', { workItemId })
    // The session is already bound; it must not appear in the intake queue at all.
    expect(await sessionWorkItem(session.id)).toBe(workItemId)
    expect(await intakeRowsFor(session.id)).toHaveLength(0)
    const page = await jsonOf<{ items: IntakeItem[] }>(await listIntake('owner'))
    expect(page.items.some((i) => i.agentSessionId === session.id)).toBe(false)
  })

  it('(c) search: filter the pending queue by host and by provider', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const host = randomUUID()
    const bySearchHost = await createSession('owner', { hostId: host })
    const codexSession = await createSession('owner', { provider: 'codex' })

    const byHost = await jsonOf<{ items: IntakeItem[] }>(
      await listIntake('owner', `?hostId=${host}`)
    )
    expect(byHost.items).toHaveLength(1)
    expect(byHost.items[0]?.agentSessionId).toBe(bySearchHost.id)

    const byProvider = await jsonOf<{ items: IntakeItem[] }>(
      await listIntake('owner', '?provider=codex')
    )
    expect(byProvider.items.every((i) => i.provider === 'codex')).toBe(true)
    expect(byProvider.items.some((i) => i.agentSessionId === codexSession.id)).toBe(true)
  })

  it('(d) assign explicitly binds the session, flips status, audits, and enforces OCC', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const intake = (await intakeRowsFor(session.id))[0]
    expect(intake).toBeDefined()
    const workItemId = randomUUID()

    // Missing If-Match → 428.
    const noIfMatch = await assign('owner', intake!.id, workItemId, null)
    expect(noIfMatch.status).toBe(428)
    // Stale If-Match → 409 VERSION_CONFLICT.
    const stale = await assign('owner', intake!.id, workItemId, '"agent-session-intake-99"')
    expect(stale.status).toBe(409)

    const ok = await assign(
      'owner',
      intake!.id,
      workItemId,
      `"agent-session-intake-${intake!.version}"`
    )
    expect(ok.status).toBe(200)
    const assigned = await jsonOf<IntakeItem>(ok)
    expect(assigned.status).toBe('assigned')
    expect(assigned.workItemId).toBe(workItemId)
    expect(assigned.assignedBy).not.toBeNull()

    // The EXPLICIT binding set the session's work_item_id — the only path that does so.
    expect(await sessionWorkItem(session.id)).toBe(workItemId)
    expect(await auditActions(intake!.id)).toContain('agent_session_intake.assigned')
    // It leaves the pending queue.
    const page = await jsonOf<{ items: IntakeItem[] }>(await listIntake('owner'))
    expect(page.items.some((i) => i.id === intake!.id)).toBe(false)
  })

  it('(e) reclassify changes the reason and dismiss removes it from the queue, both audited', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const reclassSession = await createSession('owner')
    const r1 = (await intakeRowsFor(reclassSession.id))[0]
    const recl = await reclassify(
      'owner',
      r1!.id,
      { detectedReason: 'started_outside_app' },
      `"agent-session-intake-${r1!.version}"`
    )
    expect(recl.status).toBe(200)
    expect((await jsonOf<IntakeItem>(recl)).detectedReason).toBe('started_outside_app')
    expect(await auditActions(r1!.id)).toContain('agent_session_intake.reclassified')

    const dismissSession = await createSession('owner')
    const d1 = (await intakeRowsFor(dismissSession.id))[0]
    const dis = await reclassify(
      'owner',
      d1!.id,
      { dismiss: true },
      `"agent-session-intake-${d1!.version}"`
    )
    expect(dis.status).toBe(200)
    expect((await jsonOf<IntakeItem>(dis)).status).toBe('dismissed')
    expect(await auditActions(d1!.id)).toContain('agent_session_intake.dismissed')
    // A dismissed item is out of the pending queue.
    const page = await jsonOf<{ items: IntakeItem[] }>(await listIntake('owner'))
    expect(page.items.some((i) => i.id === d1!.id)).toBe(false)
  })

  it('(f) a terminal (assigned/dismissed) intake cannot be re-assigned/re-classified — 409', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const intake = (await intakeRowsFor(session.id))[0]
    const first = await assign(
      'owner',
      intake!.id,
      randomUUID(),
      `"agent-session-intake-${intake!.version}"`
    )
    expect(first.status).toBe(200)
    const assignedVersion = (await jsonOf<IntakeItem>(first)).version
    // Reassigning an already-assigned intake is a documented conflict.
    const reassign = await assign(
      'owner',
      intake!.id,
      randomUUID(),
      `"agent-session-intake-${assignedVersion}"`
    )
    expect(reassign.status).toBe(409)
    // Reclassifying a terminal intake is likewise a conflict.
    const recl = await reclassify(
      'owner',
      intake!.id,
      { dismiss: true },
      `"agent-session-intake-${assignedVersion}"`
    )
    expect(recl.status).toBe(409)
  })

  it('(g) cross-tenant isolation: another org cannot see or assign this org’s intake', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const intake = (await intakeRowsFor(session.id))[0]
    // otherowner is not a member of orgId → no agent_session.read there.
    const read = await listIntake('otherowner')
    expect(read.status).toBe(403)
    const write = await assign(
      'otherowner',
      intake!.id,
      randomUUID(),
      `"agent-session-intake-${intake!.version}"`
    )
    expect(write.status).toBe(403)
    // The session stayed unbound.
    expect(await sessionWorkItem(session.id)).toBeNull()
  })

  it('(h) RBAC deny: a member can read the queue but cannot assign', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const intake = (await intakeRowsFor(session.id))[0]
    const read = await listIntake('member')
    expect(read.status).toBe(200)
    const denied = await assign(
      'member',
      intake!.id,
      randomUUID(),
      `"agent-session-intake-${intake!.version}"`
    )
    expect(denied.status).toBe(403)
    expect(await sessionWorkItem(session.id)).toBeNull()
  })
})
