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
let ownerId = ''
let teamId = ''
let projectId = ''
let scopeItemId = ''
let sessionId = ''
let seq = 0

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

function req(path: string): string {
  return `/v1/organizations/${orgId}/requirements${path}`
}

async function auditActions(targetId: string): Promise<string[]> {
  const rows = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('audit.audit_events')
      .select('action')
      .where('target_id', '=', targetId)
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
  )
  return rows.map((r) => r.action)
}

type RequirementWire = {
  id: string
  status: string
  version: number
  contractScopeItemId: string | null
}
type EvidenceWire = { kind: string; trustDomain: string; verifiedEvidence: boolean }
type CoverageWire = {
  hasWorkItem: boolean
  hasCodeEvidence: boolean
  hasTestEvidence: boolean
  hasDeliverableEvidence: boolean
  hasAcceptance: boolean
  isFullyTraced: boolean
  gaps: string[]
}
type TraceabilityWire = {
  requirement: RequirementWire
  contractScopeItem: { id: string; contractId: string } | null
  workItems: {
    workItemId: string
    workItem: { identifier: string } | null
    evidence: EvidenceWire[]
  }[]
  acceptances: { result: string }[]
  coverage: CoverageWire
}

async function createWorkItem(title: string): Promise<string> {
  const res = await bearerFetch('owner', `/v1/organizations/${orgId}/work-items`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ teamId, title })
  })
  expect(res.status).toBe(201)
  return (await jsonOf<{ id: string }>(res)).id
}

// Seed one execution.agent_provenance evidence row (with its backing append-only agent_event) for an
// opaque work_item_id. provenanceTrustDomain is the R5 provenance trust domain (local_observed |
// server_verified | declared) the traceability read distinguishes — declared is a mere claim.
async function seedEvidence(
  workItemId: string,
  kind: 'commit' | 'pull_request' | 'test_result' | 'build_result' | 'artifact' | 'file_change',
  provenanceTrustDomain: 'local_observed' | 'server_verified' | 'declared'
): Promise<void> {
  seq += 1
  const eventId = randomUUID()
  await withTenantTransaction(db, orgId, async (trx) => {
    await trx
      .insertInto('execution.agent_events')
      .values({
        organization_id: orgId,
        event_id: eventId,
        agent_session_id: sessionId,
        stream_id: randomUUID(),
        sequence: seq,
        type: `ai.pielab.agent.provenance.${kind}.v1`,
        source_uri: 'urn:pie:test',
        subject: `work_item/${workItemId}`,
        producer_id: ownerId,
        producer_type: 'hook',
        provider: 'claude_code',
        parser_version: '1',
        trust_domain:
          provenanceTrustDomain === 'server_verified' ? 'server_verified' : 'client_observed',
        assertion: provenanceTrustDomain === 'declared' ? 'declared' : 'observed',
        classification: 'internal',
        visibility: 'internal',
        occurred_at: new Date().toISOString(),
        captured_at: new Date().toISOString(),
        payload: JSON.stringify({ kind })
      })
      .execute()
    await trx
      .insertInto('execution.agent_provenance')
      .values({
        organization_id: orgId,
        source_event_id: eventId,
        agent_session_id: sessionId,
        kind,
        trust_domain: provenanceTrustDomain,
        work_item_id: workItemId,
        commit_sha: kind === 'commit' ? 'abc1234' : null,
        change_request_ref: kind === 'pull_request' ? 'PR-1' : null,
        command: kind === 'test_result' || kind === 'build_result' ? 'pnpm test' : null,
        exit_code: kind === 'test_result' || kind === 'build_result' ? 0 : null,
        artifact_id: kind === 'artifact' ? randomUUID() : null,
        file_path: kind === 'file_change' ? 'src/x.ts' : null,
        occurred_at: new Date().toISOString()
      })
      .execute()
  })
}

async function createRequirement(
  code: string,
  opts: { scopeItemId?: string } = {}
): Promise<RequirementWire> {
  const res = await bearerFetch('owner', req(''), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      projectId,
      code,
      title: `Requirement ${code}`,
      priority: 'high',
      ...(opts.scopeItemId ? { contractScopeItemId: opts.scopeItemId } : {})
    })
  })
  expect(res.status).toBe(201)
  return jsonOf<RequirementWire>(res)
}

// Walk draft → approved → implemented → verified via :transition (OCC), returning the verified version.
async function walkToVerified(requirement: RequirementWire): Promise<number> {
  let version = requirement.version
  for (const action of ['approve', 'implement', 'verify'] as const) {
    const res = await bearerFetch('owner', req(`/${requirement.id}:transition`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"requirement-${version}"` },
      body: JSON.stringify({ action })
    })
    expect(res.status).toBe(200)
    version = (await jsonOf<RequirementWire>(res)).version
  }
  return version
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED requirement-traceability vertical: Docker unavailable — ${String(error)}`)
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
    slug: `rq-${orgId.slice(0, 8)}`,
    displayName: 'RQ'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `rq2-${otherOrgId.slice(0, 8)}`,
    displayName: 'RQ2'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  // 'member' has requirement.read but NOT requirement.accept — used for the accept-gate deny test.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
  await seedMembershipFixture(db, {
    organizationId: otherOrgId,
    issuer: TEST_ISSUER,
    subject: 'other',
    roleIds: ['organization_owner']
  })
  // A team (for work items), a project (opaque project_id), an agent session, and a contract scope
  // line (the UP trace target) are the fixtures the requirement traces against.
  const team = await jsonOf<{ id: string }>(
    await bearerFetch('owner', `/v1/organizations/${orgId}/teams`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ key: 'CORE', name: 'Core' })
    })
  )
  teamId = team.id
  const seeded = await withTenantTransaction(db, orgId, async (trx) => {
    const project = await trx
      .insertInto('delivery.projects')
      .values({ organization_id: orgId, name: 'Traceability project' })
      .returning('id')
      .executeTakeFirstOrThrow()
    const session = await trx
      .insertInto('execution.agent_sessions')
      .values({
        organization_id: orgId,
        provider: 'claude_code',
        host_id: randomUUID(),
        visibility: 'internal',
        classification: 'internal',
        created_by: ownerId
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const account = await trx
      .insertInto('crm.accounts')
      .values({ organization_id: orgId, name: 'Acme' })
      .returning('id')
      .executeTakeFirstOrThrow()
    const contract = await trx
      .insertInto('crm.contracts')
      .values({ organization_id: orgId, account_id: account.id, title: 'SI build' })
      .returning('id')
      .executeTakeFirstOrThrow()
    const scope = await trx
      .insertInto('crm.contract_scope_items')
      .values({ organization_id: orgId, contract_id: contract.id, service_type: 'build' })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { projectId: project.id, sessionId: session.id, scopeItemId: scope.id }
  })
  projectId = seeded.projectId
  sessionId = seeded.sessionId
  scopeItemId = seeded.scopeItemId
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('requirement / traceability vertical (R6 slice 2)', () => {
  it('(a) EXIT CONDITION: a requirement traces end-to-end through work/code/test/deliverable/검수', async (ctx) => {
    if (!harness) return ctx.skip()
    const requirement = await createRequirement('REQ-1', { scopeItemId })
    expect(requirement.contractScopeItemId).toBe(scopeItemId)
    // DOWN: two work items implement the requirement.
    const wi1 = await createWorkItem('Implement API')
    const wi2 = await createWorkItem('Implement UI')
    for (const workItemId of [wi1, wi2]) {
      const linked = await bearerFetch('owner', req(`/${requirement.id}:link-work-item`), {
        method: 'POST',
        body: JSON.stringify({ workItemId })
      })
      expect(linked.status).toBe(201)
    }
    // EVIDENCE: verified commit (code) + test_result (test) + artifact (deliverable) on wi1.
    await seedEvidence(wi1, 'commit', 'server_verified')
    await seedEvidence(wi1, 'test_result', 'server_verified')
    await seedEvidence(wi1, 'artifact', 'server_verified')
    // 검수: walk to verified, then accept.
    const verifiedVersion = await walkToVerified(requirement)
    const accepted = await bearerFetch('owner', req(`/${requirement.id}:accept`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"requirement-${verifiedVersion}"` },
      body: JSON.stringify({ result: 'pass', notes: 'looks good' })
    })
    expect(accepted.status).toBe(200)

    const trace = await jsonOf<TraceabilityWire>(
      await bearerFetch('owner', req(`/${requirement.id}/traceability`))
    )
    // requirement → scope
    expect(trace.contractScopeItem?.id).toBe(scopeItemId)
    expect(trace.contractScopeItem?.contractId).toBeTruthy()
    // → work items
    expect(trace.workItems).toHaveLength(2)
    expect(trace.workItems.every((w) => w.workItem !== null)).toBe(true)
    // → code / test / deliverable evidence (all verified)
    const kinds = new Set(trace.workItems.flatMap((w) => w.evidence.map((e) => e.kind)))
    expect(kinds.has('commit')).toBe(true)
    expect(kinds.has('test_result')).toBe(true)
    expect(kinds.has('artifact')).toBe(true)
    expect(trace.workItems.flatMap((w) => w.evidence).every((e) => e.verifiedEvidence)).toBe(true)
    // → 검수
    expect(trace.acceptances).toHaveLength(1)
    expect(trace.acceptances[0]?.result).toBe('pass')
    expect(trace.requirement.status).toBe('accepted')
    // THE full chain is traced end-to-end.
    expect(trace.coverage.isFullyTraced).toBe(true)
    expect(trace.coverage.gaps).toHaveLength(0)
  })

  it('(b) GAP: a requirement with no work item / no evidence / no 검수 is flagged in coverage', async (ctx) => {
    if (!harness) return ctx.skip()
    const requirement = await createRequirement('REQ-GAP')
    const page = await jsonOf<{
      items: { requirement: RequirementWire; coverage: CoverageWire }[]
    }>(await bearerFetch('owner', req(`/coverage?projectId=${projectId}`)))
    const entry = page.items.find((i) => i.requirement.id === requirement.id)
    expect(entry).toBeTruthy()
    expect(entry?.coverage.isFullyTraced).toBe(false)
    expect(entry?.coverage.gaps).toEqual(
      expect.arrayContaining([
        'no_work_item',
        'no_code_evidence',
        'no_test_evidence',
        'no_deliverable_evidence',
        'no_acceptance'
      ])
    )
  })

  it('(c) declared-only evidence is distinguished from verified and does NOT close a gap', async (ctx) => {
    if (!harness) return ctx.skip()
    const requirement = await createRequirement('REQ-DECL')
    const wi = await createWorkItem('Declared work')
    await bearerFetch('owner', req(`/${requirement.id}:link-work-item`), {
      method: 'POST',
      body: JSON.stringify({ workItemId: wi })
    })
    // A DECLARED test claim — a mere assertion, never verified evidence (R5 CAP-005).
    await seedEvidence(wi, 'test_result', 'declared')
    const trace = await jsonOf<TraceabilityWire>(
      await bearerFetch('owner', req(`/${requirement.id}/traceability`))
    )
    const evidence = trace.workItems.flatMap((w) => w.evidence)
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.trustDomain).toBe('declared')
    expect(evidence[0]?.verifiedEvidence).toBe(false)
    // The declared test does NOT satisfy the test/code/deliverable coverage — still a gap.
    expect(trace.coverage.hasWorkItem).toBe(true)
    expect(trace.coverage.hasTestEvidence).toBe(false)
    expect(trace.coverage.gaps).toContain('no_test_evidence')
    expect(trace.coverage.isFullyTraced).toBe(false)
  })

  it('(d) 검수 is gated behind requirement.accept (member 403), audited, and OCC-guarded', async (ctx) => {
    if (!harness) return ctx.skip()
    const requirement = await createRequirement('REQ-GATE')
    const verifiedVersion = await walkToVerified(requirement)
    // A member with requirement.read but not requirement.accept is refused.
    const denied = await bearerFetch('member', req(`/${requirement.id}:accept`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"requirement-${verifiedVersion}"` },
      body: JSON.stringify({ result: 'pass' })
    })
    expect(denied.status).toBe(403)
    // Missing If-Match → 428.
    const noIfMatch = await bearerFetch('owner', req(`/${requirement.id}:accept`), {
      method: 'POST',
      body: JSON.stringify({ result: 'pass' })
    })
    expect(noIfMatch.status).toBe(428)
    // Stale If-Match → 409.
    const stale = await bearerFetch('owner', req(`/${requirement.id}:accept`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"requirement-1"` },
      body: JSON.stringify({ result: 'pass' })
    })
    expect(stale.status).toBe(409)
    // The real accept succeeds and is audited.
    const ok = await bearerFetch('owner', req(`/${requirement.id}:accept`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': `"requirement-${verifiedVersion}"` },
      body: JSON.stringify({ result: 'pass' })
    })
    expect(ok.status).toBe(200)
    const actions = await auditActions(requirement.id)
    expect(actions).toContain('requirement.created')
    expect(actions).toContain('requirement.verify')
    expect(actions).toContain('requirement.accept')
  })

  it('(e) accept is illegal before a requirement is verified', async (ctx) => {
    if (!harness) return ctx.skip()
    const requirement = await createRequirement('REQ-EARLY')
    const early = await bearerFetch('owner', req(`/${requirement.id}:accept`), {
      method: 'POST',
      headers: {
        'idempotency-key': randomUUID(),
        'if-match': `"requirement-${requirement.version}"`
      },
      body: JSON.stringify({ result: 'pass' })
    })
    expect(early.status).toBe(409)
  })

  it('(f) cross-tenant: another org owner cannot read this org requirement (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const requirement = await createRequirement('REQ-TENANT')
    const deniedGet = await bearerFetch('other', req(`/${requirement.id}`))
    expect(deniedGet.status).toBe(403)
    const deniedTrace = await bearerFetch('other', req(`/${requirement.id}/traceability`))
    expect(deniedTrace.status).toBe(403)
  })
})
