import { type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 5 reads — the two queries that CLOSE R6's exit condition
// "계획 대비 일정·공수·비용과 인력 과투입을 조회한다":
//   1. utilization: per person, summed allocation % over a window → over-allocation flag + man-months.
//   2. variance: PLANNED effort from an IMMUTABLE schedule baseline snapshot vs ACTUAL logged effort,
//      per WBS node. Reading PLANNED from baseline_entries (not the live wbs_node) is what makes the
//      comparison "계획 대비" — a post-capture edit to the live node cannot move the planned side.

// One man-month = 160 person-hours (a common PM convention: ~20 working days × 8h). Kept as a single
// stated constant so hours→MM is uniform across both reads and the wire response echoes it.
export const HOURS_PER_MAN_MONTH = 160

// Sums numeric-string effort values (null treated as absent); returns a 2-decimal string or null.
function sumEffort(values: (string | null)[]): string | null {
  let total: number | null = null
  for (const value of values) {
    if (value !== null) {
      total = (total ?? 0) + Number(value)
    }
  }
  return total === null ? null : total.toFixed(2)
}

function toManMonths(hours: string | null): string | null {
  return hours === null ? null : (Number(hours) / HOURS_PER_MAN_MONTH).toFixed(2)
}

export type UserUtilization = {
  userId: string
  assignmentCount: number
  summedAllocationPct: string
  // True when the window's summed allocation exceeds 100% of one person's capacity — the person is
  // booked past full-time across overlapping assignments (intentionally allowed at write).
  overAllocated: boolean
  plannedEffortHours: string | null
  plannedManMonths: string | null
  actualEffortHours: string | null
  actualManMonths: string | null
}

export type ProjectUtilization = {
  projectId: string
  from: string
  to: string
  hoursPerManMonth: number
  users: UserUtilization[]
}

/**
 * Per-person utilization over [from, to]: sums allocation_pct of every assignment OVERLAPPING the
 * window (overlap = start <= to AND end >= from) and flags overAllocated when that sum exceeds 100.
 * plannedManMonths comes from the overlapping assignments' planned effort; actual from effort_entries
 * dated in the window. Effort→MM uses HOURS_PER_MAN_MONTH.
 */
export async function getProjectUtilization(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string,
  from: string,
  to: string
): Promise<ProjectUtilization> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const assignments = await trx
      .selectFrom('planning.resource_assignments')
      .select(['user_id', 'allocation_pct', 'planned_effort_hours'])
      .where('project_id', '=', projectId)
      // Overlap: the assignment period intersects the query window.
      .where('start_date', '<=', to)
      .where('end_date', '>=', from)
      .execute()
    const actuals = await trx
      .selectFrom('planning.effort_entries')
      .select(['user_id', 'effort_hours'])
      .where('project_id', '=', projectId)
      .where('entry_date', '>=', from)
      .where('entry_date', '<=', to)
      .execute()

    type Acc = {
      count: number
      allocation: number
      planned: (string | null)[]
      actual: string[]
    }
    const byUser = new Map<string, Acc>()
    const accFor = (userId: string): Acc => {
      let acc = byUser.get(userId)
      if (!acc) {
        acc = { count: 0, allocation: 0, planned: [], actual: [] }
        byUser.set(userId, acc)
      }
      return acc
    }
    for (const row of assignments) {
      const acc = accFor(row.user_id)
      acc.count += 1
      acc.allocation += Number(row.allocation_pct)
      acc.planned.push(row.planned_effort_hours === null ? null : String(row.planned_effort_hours))
    }
    for (const row of actuals) {
      accFor(row.user_id).actual.push(String(row.effort_hours))
    }

    const users: UserUtilization[] = [...byUser.entries()]
      .map(([userId, acc]) => {
        const plannedEffortHours = sumEffort(acc.planned)
        const actualEffortHours = acc.actual.length === 0 ? null : sumEffort(acc.actual)
        return {
          userId,
          assignmentCount: acc.count,
          summedAllocationPct: acc.allocation.toFixed(2),
          overAllocated: acc.allocation > 100,
          plannedEffortHours,
          plannedManMonths: toManMonths(plannedEffortHours),
          actualEffortHours,
          actualManMonths: toManMonths(actualEffortHours)
        }
      })
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    return { projectId, from, to, hoursPerManMonth: HOURS_PER_MAN_MONTH, users }
  })
}

export type NodeVariance = {
  wbsNodeId: string
  wbsCode: string
  name: string
  plannedEffortHours: string | null
  actualEffortHours: string | null
  varianceHours: string
  // (actual - planned) / planned * 100; null when the baseline planned 0/none (division undefined).
  variancePct: string | null
  plannedManMonths: string | null
  actualManMonths: string | null
}

export type BaselineVariance = {
  baselineId: string
  projectId: string
  hoursPerManMonth: number
  nodes: NodeVariance[]
  totals: {
    plannedEffortHours: string | null
    actualEffortHours: string | null
    varianceHours: string
    variancePct: string | null
  }
}

function varianceHoursOf(planned: string | null, actual: string | null): string {
  return (Number(actual ?? 0) - Number(planned ?? 0)).toFixed(2)
}

function variancePctOf(planned: string | null, actual: string | null): string | null {
  const plannedNum = Number(planned ?? 0)
  if (planned === null || plannedNum === 0) {
    return null
  }
  return (((Number(actual ?? 0) - plannedNum) / plannedNum) * 100).toFixed(2)
}

/**
 * Planned-vs-actual variance for a captured baseline — R6's exit-condition query. PLANNED is each
 * baseline entry's SNAPSHOTTED planned_effort_hours (frozen at capture); ACTUAL is the sum of
 * effort_entries logged against that entry's wbs_node_id. Returns null if the baseline is absent.
 */
export async function getBaselineVariance(
  db: Kysely<Database>,
  organizationId: string,
  baselineId: string
): Promise<BaselineVariance | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const header = await trx
      .selectFrom('planning.schedule_baselines')
      .select(['id', 'project_id'])
      .where('id', '=', baselineId)
      .executeTakeFirst()
    if (!header) {
      return null
    }
    const entries = await trx
      .selectFrom('planning.baseline_entries')
      .select(['wbs_node_id', 'wbs_code', 'name', 'planned_effort_hours'])
      .where('baseline_id', '=', baselineId)
      .orderBy('sort_order', 'asc')
      .orderBy('wbs_code', 'asc')
      .orderBy('id', 'asc')
      .execute()
    // Actuals summed per wbs_node across the whole project — the frozen baseline decides the planned
    // side, so a later edit or delete of the live node never moves it.
    const actualRows = await trx
      .selectFrom('planning.effort_entries')
      .select(['wbs_node_id', 'effort_hours'])
      .where('project_id', '=', header.project_id)
      .execute()
    const actualByNode = new Map<string, string[]>()
    for (const row of actualRows) {
      if (row.wbs_node_id === null) {
        continue
      }
      const list = actualByNode.get(row.wbs_node_id) ?? []
      list.push(String(row.effort_hours))
      actualByNode.set(row.wbs_node_id, list)
    }

    const nodes: NodeVariance[] = entries.map((entry) => {
      const plannedEffortHours =
        entry.planned_effort_hours === null ? null : String(entry.planned_effort_hours)
      const actualList = actualByNode.get(entry.wbs_node_id) ?? []
      const actualEffortHours = actualList.length === 0 ? null : sumEffort(actualList)
      return {
        wbsNodeId: entry.wbs_node_id,
        wbsCode: entry.wbs_code,
        name: entry.name,
        plannedEffortHours,
        actualEffortHours,
        varianceHours: varianceHoursOf(plannedEffortHours, actualEffortHours),
        variancePct: variancePctOf(plannedEffortHours, actualEffortHours),
        plannedManMonths: toManMonths(plannedEffortHours),
        actualManMonths: toManMonths(actualEffortHours)
      }
    })
    const totalPlanned = sumEffort(nodes.map((n) => n.plannedEffortHours))
    const totalActual = sumEffort(nodes.map((n) => n.actualEffortHours))
    return {
      baselineId,
      projectId: header.project_id,
      hoursPerManMonth: HOURS_PER_MAN_MONTH,
      nodes,
      totals: {
        plannedEffortHours: totalPlanned,
        actualEffortHours: totalActual,
        varianceHours: varianceHoursOf(totalPlanned, totalActual),
        variancePct: variancePctOf(totalPlanned, totalActual)
      }
    }
  })
}
