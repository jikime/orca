import { type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { mapDefect, type DefectResource } from './defect-store'
import { mapDeliverable, type DeliverableResource } from './deliverable-store'
import { mapTestCase, type TestCaseResource } from './test-case-store'
import { withTenantTransaction } from './tenant-transaction'

// R6 qa — the traceability READ that carries the exit-condition evidence at the qa layer:
// "요구사항이 ... 테스트, 산출물 ... 까지 추적된다." For one requirement it returns the deliverables (산출물)
// and test_cases directly linked to it, plus the defects raised against those test_cases/deliverables
// (defects reach a requirement THROUGH its test/산출물, not by a direct requirement_id column). The
// s2 work_items + acceptances live in requirement-traceability-query; this covers the qa layer.

export type QaCoverage = {
  hasDeliverable: boolean
  hasTestCase: boolean
  // At least one test case that actually ran green (status='passed').
  hasPassingTest: boolean
  hasAcceptedDeliverable: boolean
  // An open defect (not resolved/closed/wontfix) blocking the requirement.
  hasOpenDefect: boolean
  testCaseCount: number
  deliverableCount: number
  defectCount: number
}

export type QaTraceability = {
  requirementId: string
  deliverables: DeliverableResource[]
  testCases: TestCaseResource[]
  defects: DefectResource[]
  coverage: QaCoverage
}

const OPEN_DEFECT_STATUSES: ReadonlySet<string> = new Set(['open', 'triaged', 'in_progress'])

async function loadDefectsForRequirement(
  trx: Transaction<Database>,
  testCaseIds: string[],
  deliverableIds: string[]
): Promise<DefectResource[]> {
  if (testCaseIds.length === 0 && deliverableIds.length === 0) {
    return []
  }
  let query = trx.selectFrom('qa.defects').selectAll()
  // Defects linked to this requirement's test cases OR its deliverables. Empty id lists must not match
  // everything, so each side is gated on having ids before it is OR-ed in.
  query = query.where((eb) => {
    const clauses = []
    if (testCaseIds.length > 0) {
      clauses.push(eb('test_case_id', 'in', testCaseIds))
    }
    if (deliverableIds.length > 0) {
      clauses.push(eb('deliverable_id', 'in', deliverableIds))
    }
    return eb.or(clauses)
  })
  const rows = await query.orderBy('created_at', 'asc').orderBy('id', 'asc').execute()
  return rows.map(mapDefect)
}

/**
 * The qa traceability chain for one requirement, or null if the requirement is not visible in this
 * org. Ties the requirement to its deliverables + test cases + the defects raised against them, and
 * distills a coverage view (has-test / has-산출물 / passing / open-defect).
 */
export async function getQaTraceability(
  db: Kysely<Database>,
  organizationId: string,
  requirementId: string
): Promise<QaTraceability | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const requirementRow = await trx
      .selectFrom('requirements.requirements')
      .select('id')
      .where('id', '=', requirementId)
      .executeTakeFirst()
    if (!requirementRow) {
      return null
    }

    const deliverableRows = await trx
      .selectFrom('qa.deliverables')
      .selectAll()
      .where('requirement_id', '=', requirementId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    const deliverables = deliverableRows.map(mapDeliverable)

    const testCaseRows = await trx
      .selectFrom('qa.test_cases')
      .selectAll()
      .where('requirement_id', '=', requirementId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    const testCases = testCaseRows.map(mapTestCase)

    const defects = await loadDefectsForRequirement(
      trx,
      testCases.map((tc) => tc.id),
      deliverables.map((d) => d.id)
    )

    const coverage: QaCoverage = {
      hasDeliverable: deliverables.length > 0,
      hasTestCase: testCases.length > 0,
      hasPassingTest: testCases.some((tc) => tc.status === 'passed'),
      hasAcceptedDeliverable: deliverables.some((d) => d.status === 'accepted'),
      hasOpenDefect: defects.some((d) => OPEN_DEFECT_STATUSES.has(d.status)),
      testCaseCount: testCases.length,
      deliverableCount: deliverables.length,
      defectCount: defects.length
    }

    return { requirementId, deliverables, testCases, defects, coverage }
  })
}
