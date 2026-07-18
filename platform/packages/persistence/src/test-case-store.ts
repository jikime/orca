import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditQaEvent, emitQaResourceChange } from './qa-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R6 qa — a TEST CASE that verifies a requirement / work item. Traces to a requirement (opaque
// requirement_id) so the qa-traceability read can answer "which tests verify this requirement". A
// pass/fail is the OCC :transition. requirement_id / work_item_id are OPAQUE cross-schema ids — no
// cross-schema FK, same-tenant integrity via the shared organization_id.

export type TestCaseStatus = 'draft' | 'ready' | 'passed' | 'failed' | 'blocked'
export type TestCaseAction = 'ready' | 'pass' | 'fail' | 'block'

export type TestCaseResource = {
  id: string
  organizationId: string
  requirementId: string | null
  workItemId: string | null
  title: string
  steps: string | null
  expected: string | null
  status: TestCaseStatus
  version: number
  createdAt: string
  updatedAt: string
}

type TestCaseRow = {
  id: string
  organization_id: string
  requirement_id: string | null
  work_item_id: string | null
  title: string
  steps: string | null
  expected: string | null
  status: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapTestCase(row: TestCaseRow): TestCaseResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    requirementId: row.requirement_id,
    workItemId: row.work_item_id,
    title: row.title,
    steps: row.steps,
    expected: row.expected,
    status: row.status as TestCaseStatus,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateTestCaseInput = {
  organizationId: string
  actorUserId: string
  requirementId?: string | null
  workItemId?: string | null
  title: string
  steps?: string | null
  expected?: string | null
}

/** Creates a test case in status='draft'. It reaches passed/failed only via the :transition chain. */
export async function createTestCase(
  db: Kysely<Database>,
  input: CreateTestCaseInput
): Promise<TestCaseResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('qa.test_cases')
      .values({
        organization_id: input.organizationId,
        requirement_id: input.requirementId ?? null,
        work_item_id: input.workItemId ?? null,
        title: input.title,
        steps: input.steps ?? null,
        expected: input.expected ?? null,
        status: 'draft'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditQaEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'test_case.created',
      'test_case',
      row.id
    )
    await emitQaResourceChange(trx, input.organizationId, 'test_case', row.id, 1, 'created')
    return mapTestCase(row)
  })
}

export async function getTestCase(
  db: Kysely<Database>,
  organizationId: string,
  testCaseId: string
): Promise<TestCaseResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('qa.test_cases')
      .selectAll()
      .where('id', '=', testCaseId)
      .executeTakeFirst()
    return row ? mapTestCase(row) : null
  })
}

export type TestCasePage = { items: TestCaseResource[]; nextCursor: string | null }

// Test cases are queried by requirement (the trace) rather than by project, since a test case links
// to a requirement/work item, not directly to a project.
export async function listTestCasesByRequirement(
  db: Kysely<Database>,
  organizationId: string,
  requirementId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<TestCasePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('qa.test_cases')
      .selectAll()
      .where('requirement_id', '=', requirementId)
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapTestCase), nextCursor }
  })
}

export type UpdateTestCaseResult =
  | { ok: true; testCase: TestCaseResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export type UpdateTestCaseInput = {
  organizationId: string
  testCaseId: string
  actorUserId: string
  expectedVersion: number
  title?: string
  steps?: string | null
  expected?: string | null
  requirementId?: string | null
  workItemId?: string | null
}

/** Edits test-case metadata under OCC (If-Match). Status is changed only via :transition. */
export async function updateTestCase(
  db: Kysely<Database>,
  input: UpdateTestCaseInput
): Promise<UpdateTestCaseResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('qa.test_cases')
      .selectAll()
      .where('id', '=', input.testCaseId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('qa.test_cases')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.steps === undefined ? {} : { steps: input.steps }),
        ...(input.expected === undefined ? {} : { expected: input.expected }),
        ...(input.requirementId === undefined ? {} : { requirement_id: input.requirementId }),
        ...(input.workItemId === undefined ? {} : { work_item_id: input.workItemId })
      })
      .where('id', '=', input.testCaseId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditQaEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'test_case.updated',
      'test_case',
      updated.id
    )
    await emitQaResourceChange(
      trx,
      input.organizationId,
      'test_case',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, testCase: mapTestCase(updated) }
  })
}

export type TestCaseTransitionResult =
  | { ok: true; testCase: TestCaseResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: TestCaseStatus }

// Legal edges: draft → ready (ready); then ready/passed/failed/blocked → passed|failed|blocked so a
// test can be re-run (pass/fail/block) after any executed outcome. A draft cannot be executed.
const EXECUTABLE_FROM: readonly TestCaseStatus[] = ['ready', 'passed', 'failed', 'blocked']
const TO_STATUS: Record<TestCaseAction, TestCaseStatus> = {
  ready: 'ready',
  pass: 'passed',
  fail: 'failed',
  block: 'blocked'
}

function isLegalTestCaseTransition(action: TestCaseAction, from: TestCaseStatus): boolean {
  if (action === 'ready') {
    return from === 'draft'
  }
  return EXECUTABLE_FROM.includes(from)
}

/** Advances a test case under OCC (If-Match). pass/fail is the load-bearing verify outcome. */
export async function transitionTestCase(
  db: Kysely<Database>,
  input: {
    organizationId: string
    testCaseId: string
    actorUserId: string
    action: TestCaseAction
    expectedVersion: number
  }
): Promise<TestCaseTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('qa.test_cases')
      .selectAll()
      .where('id', '=', input.testCaseId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as TestCaseStatus
    if (!isLegalTestCaseTransition(input.action, from)) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('qa.test_cases')
      .set({ status: TO_STATUS[input.action], version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.testCaseId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditQaEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `test_case.${input.action}`,
      'test_case',
      input.testCaseId
    )
    await emitQaResourceChange(
      trx,
      input.organizationId,
      'test_case',
      input.testCaseId,
      newVersion,
      'updated'
    )
    return { ok: true, testCase: mapTestCase(updated) }
  })
}
