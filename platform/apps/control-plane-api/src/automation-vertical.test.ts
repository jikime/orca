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
let ownerId = '' // organization_owner: manage + approve + run + workqueue

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

function org(suffix: string): string {
  return `/v1/organizations/${orgId}${suffix}`
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

type RunbookWire = { id: string; requiresApproval: boolean; version: number }
type ExecutionWire = {
  id: string
  status: string
  version: number
  targetId: string
  approverUserId: string | null
  approvedAt: string | null
  result: unknown | null
  rollbackOfExecutionId: string | null
}
type WorkItemWire = {
  id: string
  status: string
  version: number
  assigneeUserId: string | null
}

async function createRunbook(requiresApproval: boolean): Promise<RunbookWire> {
  const res = await bearerFetch('owner', org('/runbooks'), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      name: 'Restart service',
      description: 'Rolling restart',
      steps: [{ op: 'drain' }, { op: 'restart' }],
      targetKind: 'environment',
      requiresApproval
    })
  })
  expect(res.status).toBe(201)
  return jsonOf<RunbookWire>(res)
}

async function createExecution(runbookId: string): Promise<ExecutionWire> {
  const res = await bearerFetch('owner', org(`/runbooks/${runbookId}/executions`), {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ targetId: randomUUID(), targetKind: 'environment' })
  })
  expect(res.status).toBe(201)
  return jsonOf<ExecutionWire>(res)
}

function execEtag(version: number): string {
  return `"runbook-execution-${version}"`
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED automation vertical: Docker unavailable — ${String(error)}`)
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
    slug: `auto-${orgId.slice(0, 8)}`,
    displayName: 'Automation'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `auto2-${otherOrgId.slice(0, 8)}`,
    displayName: 'Automation2'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      roleIds: ['organization_owner']
    })
  ).userId
  // 'member' has workqueue.read only — no runbook.approve/run/manage or workqueue.manage.
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'member',
    roleIds: ['member']
  })
  // 'other' is an owner of a DIFFERENT org — used for cross-tenant isolation.
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

describe('automation vertical (R7 approval-gated runbooks + work queue)', () => {
  it('(a) EXIT CONDITION: run is refused before approval, then approve→run→complete is audited', async (ctx) => {
    if (!harness) return ctx.skip()
    const runbook = await createRunbook(true)
    expect(runbook.requiresApproval).toBe(true)
    const execution = await createExecution(runbook.id)
    expect(execution.status).toBe('pending_approval')
    expect(execution.targetId).not.toBe('') // the AUDITED target is recorded on the run

    // A pending_approval execution cannot run → 422 RUNBOOK_NOT_APPROVED.
    const pendingRun = await bearerFetch('owner', org(`/runbook-executions/${execution.id}:run`), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': execEtag(execution.version) }
    })
    expect(pendingRun.status).toBe(422)
    expect((await jsonOf<{ code: string }>(pendingRun)).code).toBe('RUNBOOK_NOT_APPROVED')

    // Approve (approver recorded), then run succeeds → running.
    const approved = await jsonOf<ExecutionWire>(
      await bearerFetch('owner', org(`/runbook-executions/${execution.id}:approve`), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': execEtag(execution.version) }
      })
    )
    expect(approved.status).toBe('approved')
    expect(approved.approverUserId).toBe(ownerId)
    expect(approved.approvedAt).not.toBeNull()

    const running = await jsonOf<ExecutionWire>(
      await bearerFetch('owner', org(`/runbook-executions/${execution.id}:run`), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': execEtag(approved.version) }
      })
    )
    expect(running.status).toBe('running')

    const completed = await jsonOf<ExecutionWire>(
      await bearerFetch('owner', org(`/runbook-executions/${execution.id}:complete`), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': execEtag(running.version) },
        body: JSON.stringify({ result: { exitCode: 0, restarted: 3 } })
      })
    )
    expect(completed.status).toBe('completed')
    expect(completed.result).toMatchObject({ exitCode: 0, restarted: 3 })

    // target, approval, run, and result all landed in the audit trail (plus the refusal).
    const actions = await auditActions(execution.id)
    expect(actions).toContain('automation.runbook.execution.requested') // target
    expect(actions).toContain('automation.runbook.execution.run_refused')
    expect(actions).toContain('automation.runbook.execution.approved') // approval
    expect(actions).toContain('automation.runbook.execution.ran') // run
    expect(actions).toContain('automation.runbook.execution.completed') // result
  })

  it('(b) rollback is a NEW audited execution referencing the original', async (ctx) => {
    if (!harness) return ctx.skip()
    const runbook = await createRunbook(false) // no approval needed → opens 'approved'
    const execution = await createExecution(runbook.id)
    expect(execution.status).toBe('approved')
    const running = await jsonOf<ExecutionWire>(
      await bearerFetch('owner', org(`/runbook-executions/${execution.id}:run`), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': execEtag(execution.version) }
      })
    )
    const completed = await jsonOf<ExecutionWire>(
      await bearerFetch('owner', org(`/runbook-executions/${execution.id}:complete`), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': execEtag(running.version) },
        body: JSON.stringify({ result: { ok: true } })
      })
    )
    // Rollback creates a NEW execution referencing the original.
    const rollback = await jsonOf<ExecutionWire>(
      await bearerFetch('owner', org(`/runbook-executions/${execution.id}:rollback`), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID(), 'if-match': execEtag(completed.version) }
      })
    )
    expect(rollback.id).not.toBe(execution.id)
    expect(rollback.status).toBe('rolled_back')
    expect(rollback.rollbackOfExecutionId).toBe(execution.id)
    const actions = await auditActions(rollback.id)
    expect(actions).toContain('automation.runbook.execution.rolled_back')
  })

  it('(c) approve requires automation.runbook.approve (member 403); OCC on approve (428/409/200)', async (ctx) => {
    if (!harness) return ctx.skip()
    const runbook = await createRunbook(true)
    const execution = await createExecution(runbook.id)
    const approvePath = org(`/runbook-executions/${execution.id}:approve`)
    // 'member' lacks the approval permission → the critical gate denies it.
    const denied = await bearerFetch('member', approvePath, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': execEtag(execution.version) }
    })
    expect(denied.status).toBe(403)
    // Missing If-Match → 428.
    const noIfMatch = await bearerFetch('owner', approvePath, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() }
    })
    expect(noIfMatch.status).toBe(428)
    // Stale version → 409.
    const stale = await bearerFetch('owner', approvePath, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': execEtag(execution.version + 5) }
    })
    expect(stale.status).toBe(409)
    // Correct version → 200.
    const ok = await bearerFetch('owner', approvePath, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'if-match': execEtag(execution.version) }
    })
    expect(ok.status).toBe(200)
  })

  it('(d) work queue: create → claim (assignee set) → transition done', async (ctx) => {
    if (!harness) return ctx.skip()
    const created = await jsonOf<WorkItemWire>(
      await bearerFetch('owner', org('/work-queue-items'), {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ title: 'Review restart', kind: 'runbook_review', priority: 'high' })
      })
    )
    expect(created.status).toBe('queued')
    const claimed = await jsonOf<WorkItemWire>(
      await bearerFetch('owner', org(`/work-queue-items/${created.id}:claim`), {
        method: 'POST',
        headers: {
          'idempotency-key': randomUUID(),
          'if-match': `"work-queue-item-${created.version}"`
        }
      })
    )
    expect(claimed.status).toBe('claimed')
    expect(claimed.assigneeUserId).toBe(ownerId)
    const inProgress = await jsonOf<WorkItemWire>(
      await bearerFetch('owner', org(`/work-queue-items/${created.id}:transition`), {
        method: 'POST',
        headers: {
          'idempotency-key': randomUUID(),
          'if-match': `"work-queue-item-${claimed.version}"`
        },
        body: JSON.stringify({ toStatus: 'in_progress' })
      })
    )
    expect(inProgress.status).toBe('in_progress')
    const done = await jsonOf<WorkItemWire>(
      await bearerFetch('owner', org(`/work-queue-items/${created.id}:transition`), {
        method: 'POST',
        headers: {
          'idempotency-key': randomUUID(),
          'if-match': `"work-queue-item-${inProgress.version}"`
        },
        body: JSON.stringify({ toStatus: 'done' })
      })
    )
    expect(done.status).toBe('done')
  })

  it('(e) RBAC: member (workqueue.read only) cannot create a work queue item (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const denied = await bearerFetch('member', org('/work-queue-items'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ title: 'x', kind: 'y' })
    })
    expect(denied.status).toBe(403)
  })

  it('(f) cross-tenant: another org owner cannot read this org runbook (403)', async (ctx) => {
    if (!harness) return ctx.skip()
    const runbook = await createRunbook(true)
    const denied = await bearerFetch('other', org(`/runbooks/${runbook.id}`))
    expect(denied.status).toBe(403)
  })
})
