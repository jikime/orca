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

async function createSession(token: string, org = orgId): Promise<{ id: string }> {
  const res = await bearerFetch(token, sessionsPath(org), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ provider: 'claude_code', hostId: randomUUID() })
  })
  expect(res.status).toBe(201)
  return jsonOf<{ id: string }>(res)
}

type ProvKind =
  | 'file_change'
  | 'artifact'
  | 'commit'
  | 'pull_request'
  | 'test_result'
  | 'build_result'
type EventTrust = 'client_observed' | 'provider_asserted' | 'server_verified'
type Assertion = 'observed' | 'declared' | 'verified'

type ProvEnvelope = {
  id?: string
  sessionId: string
  streamId: string
  sequence: number
  kind: ProvKind
  provenance: Record<string, unknown>
  trustDomain?: EventTrust
  assertion?: Assertion
  pieorgid?: string
}

// A provenance-typed agent-event envelope (type = ai.pielab.agent.provenance.<kind>.v1).
function provEnvelope(o: ProvEnvelope): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: o.id ?? randomUUID(),
    source: 'urn:pie:client:installation',
    type: `ai.pielab.agent.provenance.${o.kind}.v1`,
    subject: 'provenance',
    time: new Date().toISOString(),
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
        turnId: null
      },
      producer: {
        type: 'runtime_observer',
        provider: 'claude_code',
        parserVersion: '1.0.0',
        trustDomain: o.trustDomain ?? 'client_observed'
      },
      assertion: o.assertion ?? 'observed',
      classification: 'internal',
      visibility: 'internal',
      payload: { provenance: { kind: o.kind, ...o.provenance } },
      capturedAt: new Date().toISOString()
    }
  }
}

function ingest(
  token: string,
  events: Record<string, unknown>[],
  streamId: string
): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${orgId}/agent-events:batch`, {
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

type BatchResult = { results: { id: string; status: string; code?: string }[] }
type ProvItem = {
  id: string
  kind: string
  trustDomain: string
  verifiedEvidence: boolean
  provider: string | null
  commitSha: string | null
  changeRequest: { ref: string; sourceBranch: string | null; targetBranch: string | null } | null
  execution: { command: string; exitCode: number | null; parserVersion: string | null } | null
  fileChange: { path: string } | null
  artifactId: string | null
  revision: number
  correctsProvenanceId: string | null
}

function provenance(token: string, sessionId: string): Promise<Response> {
  return bearerFetch(token, `${sessionsPath()}/${sessionId}/provenance`)
}

async function countProvenance(sessionId: string): Promise<number> {
  const row = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('execution.agent_provenance')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('agent_session_id', '=', sessionId)
      .executeTakeFirstOrThrow()
  )
  return Number(row.c)
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED agent-provenance vertical: Docker unavailable — ${String(error)}`)
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
  // A plain member has agent_session.read but NOT agent_event.ingest (RBAC deny path).
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

describe('agent-provenance ingest + read vertical (R5 s4a)', () => {
  it('(a) projects commit, PR (github) + MR (gitlab), test/build, artifact, file_change with trust + links', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const artifactId = randomUUID()
    const events = [
      provEnvelope({
        sessionId: session.id,
        streamId,
        sequence: 1,
        kind: 'commit',
        trustDomain: 'client_observed',
        provenance: {
          provider: 'github',
          repository: 'acme/app',
          commitSha: 'abc123',
          sourceRevision: 'main'
        }
      }),
      // A GitHub PR and a GitLab MR are the SAME pull_request kind, distinguished by provider.
      provEnvelope({
        sessionId: session.id,
        streamId,
        sequence: 2,
        kind: 'pull_request',
        trustDomain: 'server_verified',
        provenance: {
          provider: 'github',
          repository: 'acme/app',
          changeRequest: {
            ref: '42',
            url: 'https://github.com/acme/app/pull/42',
            state: 'open',
            sourceBranch: 'feat',
            targetBranch: 'main'
          }
        }
      }),
      provEnvelope({
        sessionId: session.id,
        streamId,
        sequence: 3,
        kind: 'pull_request',
        trustDomain: 'server_verified',
        provenance: {
          provider: 'gitlab',
          repository: 'acme/app',
          changeRequest: {
            ref: '7',
            url: 'https://gitlab.com/acme/app/-/merge_requests/7',
            state: 'opened',
            sourceBranch: 'feat',
            targetBranch: 'main'
          }
        }
      }),
      provEnvelope({
        sessionId: session.id,
        streamId,
        sequence: 4,
        kind: 'test_result',
        trustDomain: 'server_verified',
        assertion: 'verified',
        provenance: {
          sourceRevision: 'abc123',
          execution: {
            command: 'pnpm test',
            execEnvironment: 'ci:linux',
            exitCode: 0,
            parserVersion: 'junit-1.2'
          }
        }
      }),
      provEnvelope({
        sessionId: session.id,
        streamId,
        sequence: 5,
        kind: 'build_result',
        trustDomain: 'client_observed',
        provenance: {
          sourceRevision: 'abc123',
          execution: {
            command: 'pnpm build',
            execEnvironment: 'local',
            exitCode: 1,
            parserVersion: 'tsc-5.7'
          }
        }
      }),
      provEnvelope({
        sessionId: session.id,
        streamId,
        sequence: 6,
        kind: 'artifact',
        trustDomain: 'client_observed',
        provenance: { artifactId, contentHash: 'sha256:deadbeef' }
      }),
      provEnvelope({
        sessionId: session.id,
        streamId,
        sequence: 7,
        kind: 'file_change',
        trustDomain: 'client_observed',
        provenance: { fileChange: { path: 'src/index.ts', changeType: 'modified' } }
      })
    ]
    const res = await jsonOf<BatchResult>(await ingest('owner', events, streamId))
    expect(res.results.every((r) => r.status === 'accepted')).toBe(true)

    const page = await jsonOf<{ items: ProvItem[] }>(await provenance('owner', session.id))
    const byKind = (k: string): ProvItem[] => page.items.filter((i) => i.kind === k)
    expect(page.items).toHaveLength(7)
    expect(byKind('commit')[0]?.commitSha).toBe('abc123')
    // Provider-agnostic PR/MR: two pull_request rows distinguished only by provider.
    const prs = byKind('pull_request')
    expect(prs.map((p) => p.provider).sort()).toEqual(['github', 'gitlab'])
    expect(prs.every((p) => p.trustDomain === 'server_verified')).toBe(true)
    const test = byKind('test_result')[0]
    expect(test?.execution?.exitCode).toBe(0)
    expect(test?.execution?.parserVersion).toBe('junit-1.2')
    expect(byKind('build_result')[0]?.execution?.exitCode).toBe(1)
    expect(byKind('artifact')[0]?.artifactId).toBe(artifactId)
    expect(byKind('file_change')[0]?.fileChange?.path).toBe('src/index.ts')
    // Every projected row from a non-declared event is verified evidence.
    expect(page.items.every((i) => i.verifiedEvidence)).toBe(true)
  })

  it('(b) CAP-005: a declared "task complete" is stored but NOT surfaced as verified evidence', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    // The agent DECLARES a commit is done — even server_verified producer trust cannot promote a
    // declared claim to evidence (declared wins).
    await ingest(
      'owner',
      [
        provEnvelope({
          sessionId: session.id,
          streamId,
          sequence: 1,
          kind: 'commit',
          assertion: 'declared',
          trustDomain: 'server_verified',
          provenance: { provider: 'github', commitSha: 'claimed999' }
        })
      ],
      streamId
    )
    const page = await jsonOf<{ items: ProvItem[] }>(await provenance('owner', session.id))
    expect(page.items).toHaveLength(1)
    const claim = page.items[0]
    expect(claim?.trustDomain).toBe('declared')
    // The load-bearing CAP-005 assertion: a declared claim is never verified evidence.
    expect(claim?.verifiedEvidence).toBe(false)
    // Filtering to verified/observed evidence omits it entirely.
    const evidence = page.items.filter((i) => i.verifiedEvidence)
    expect(evidence).toHaveLength(0)
  })

  it('(c) trust-domain separation: local_observed and server_verified stay distinct', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    await ingest(
      'owner',
      [
        provEnvelope({
          sessionId: session.id,
          streamId,
          sequence: 1,
          kind: 'commit',
          trustDomain: 'client_observed',
          provenance: { commitSha: 'localobs' }
        }),
        provEnvelope({
          sessionId: session.id,
          streamId,
          sequence: 2,
          kind: 'commit',
          trustDomain: 'server_verified',
          provenance: { commitSha: 'civerified' }
        })
      ],
      streamId
    )
    const page = await jsonOf<{ items: ProvItem[] }>(await provenance('owner', session.id))
    const domains = new Map(page.items.map((i) => [i.commitSha, i.trustDomain]))
    expect(domains.get('localobs')).toBe('local_observed')
    expect(domains.get('civerified')).toBe('server_verified')
    // Both are verified evidence (first-hand), but they are DIFFERENT trust domains.
    expect(page.items.every((i) => i.verifiedEvidence)).toBe(true)
  })

  it('(d) idempotent replay: same eventId → no duplicate provenance row', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const eventId = randomUUID()
    const make = (): Record<string, unknown> =>
      provEnvelope({
        id: eventId,
        sessionId: session.id,
        streamId,
        sequence: 1,
        kind: 'commit',
        provenance: { commitSha: 'once' }
      })
    const first = await jsonOf<BatchResult>(await ingest('owner', [make()], streamId))
    expect(first.results[0]?.status).toBe('accepted')
    const replay = await jsonOf<BatchResult>(await ingest('owner', [make()], streamId))
    expect(replay.results[0]?.status).toBe('duplicate')
    expect(await countProvenance(session.id)).toBe(1)
  })

  it('(e) immutability: a correction creates a NEW revision and does not mutate the prior', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    await ingest(
      'owner',
      [
        provEnvelope({
          sessionId: session.id,
          streamId,
          sequence: 1,
          kind: 'test_result',
          provenance: { execution: { command: 'pnpm test', exitCode: 1, parserVersion: 'v1' } }
        })
      ],
      streamId
    )
    let page = await jsonOf<{ items: ProvItem[] }>(await provenance('owner', session.id))
    const prior = page.items[0]
    expect(prior?.revision).toBe(1)
    expect(prior?.execution?.exitCode).toBe(1)

    // A correction (reclassification) supersedes the prior evidence with a new revision row.
    await ingest(
      'owner',
      [
        provEnvelope({
          sessionId: session.id,
          streamId,
          sequence: 2,
          kind: 'test_result',
          provenance: {
            correctsProvenanceId: prior?.id,
            execution: { command: 'pnpm test', exitCode: 0, parserVersion: 'v1' }
          }
        })
      ],
      streamId
    )
    page = await jsonOf<{ items: ProvItem[] }>(await provenance('owner', session.id))
    expect(page.items).toHaveLength(2)
    const correction = page.items.find((i) => i.correctsProvenanceId === prior?.id)
    const untouched = page.items.find((i) => i.id === prior?.id)
    expect(correction?.revision).toBe(2)
    expect(correction?.execution?.exitCode).toBe(0)
    // The prior row is UNCHANGED — still revision 1 with its original exit code.
    expect(untouched?.revision).toBe(1)
    expect(untouched?.execution?.exitCode).toBe(1)

    // The reclassification is audited distinctly from a first ingest.
    const audits = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.audit_events')
        .select('action')
        .where('organization_id', '=', orgId)
        .where('target_id', '=', correction?.id ?? '')
        .execute()
    )
    expect(audits.some((a) => a.action === 'provenance.reclassified')).toBe(true)
  })

  it('(f) a provenance event with a malformed payload is permanently rejected', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    // test_result missing the required command/exitCode/parserVersion → rejected, not projected.
    const res = await jsonOf<BatchResult>(
      await ingest(
        'owner',
        [
          provEnvelope({
            sessionId: session.id,
            streamId,
            sequence: 1,
            kind: 'test_result',
            provenance: {}
          })
        ],
        streamId
      )
    )
    expect(res.results[0]?.status).toBe('permanent_rejected')
    expect(res.results[0]?.code).toBe('PROVENANCE_INVALID')
    expect(await countProvenance(session.id)).toBe(0)
  })

  it('(g) cross-tenant isolation: another org cannot read a session or ingest its provenance', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const read = await provenance('otherowner', session.id)
    expect(read.status).toBe(403)
    const write = await ingest(
      'otherowner',
      [
        provEnvelope({
          sessionId: session.id,
          streamId: randomUUID(),
          sequence: 1,
          kind: 'commit',
          provenance: { commitSha: 'x' }
        })
      ],
      randomUUID()
    )
    expect(write.status).toBe(403)
  })

  it('(h) RBAC deny: a member without agent_event.ingest gets 403 (but can still read)', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const denied = await ingest(
      'member',
      [
        provEnvelope({
          sessionId: session.id,
          streamId: randomUUID(),
          sequence: 1,
          kind: 'commit',
          provenance: { commitSha: 'y' }
        })
      ],
      randomUUID()
    )
    expect(denied.status).toBe(403)
    const read = await provenance('member', session.id)
    expect(read.status).toBe(200)
  })

  it('(i) append-only: an UPDATE or DELETE of a provenance row by the app role fails', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    await ingest(
      'owner',
      [
        provEnvelope({
          sessionId: session.id,
          streamId,
          sequence: 1,
          kind: 'commit',
          provenance: { commitSha: 'z' }
        })
      ],
      streamId
    )
    await expect(
      withTenantTransaction(db, orgId, (trx) =>
        trx
          .updateTable('execution.agent_provenance')
          .set({ commit_sha: 'tampered' })
          .where('agent_session_id', '=', session.id)
          .execute()
      )
    ).rejects.toThrow()
    await expect(
      withTenantTransaction(db, orgId, (trx) =>
        trx
          .deleteFrom('execution.agent_provenance')
          .where('agent_session_id', '=', session.id)
          .execute()
      )
    ).rejects.toThrow()
  })
})
