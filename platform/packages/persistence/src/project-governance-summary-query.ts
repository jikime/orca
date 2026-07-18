import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { mapProjectDecision, type ProjectDecisionResource } from './project-decision-store'
import { type RiskSeverity } from './project-risk-store'
import { mapStatusReport, type StatusReportResource } from './status-report-store'
import { withTenantTransaction } from './tenant-transaction'

// R6 governance — a cheap per-project rollup: still-open risks bucketed by severity, the latest status
// report, and the most recent decisions. One read the PM console can poll to answer "where does this
// project stand". A risk counts as still-open when its status is open or mitigating.

export type OpenRiskSeverityCounts = Record<RiskSeverity, number>

export type ProjectGovernanceSummary = {
  projectId: string
  openRisksBySeverity: OpenRiskSeverityCounts
  openRiskCount: number
  latestStatusReport: StatusReportResource | null
  recentDecisions: ProjectDecisionResource[]
}

const RECENT_DECISION_LIMIT = 5

export async function getProjectGovernanceSummary(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string
): Promise<ProjectGovernanceSummary> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const severityRows = await trx
      .selectFrom('governance.project_risks')
      .select(['severity'])
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('project_id', '=', projectId)
      .where('status', 'in', ['open', 'mitigating'])
      .groupBy('severity')
      .execute()
    const openRisksBySeverity: OpenRiskSeverityCounts = { low: 0, medium: 0, high: 0, critical: 0 }
    let openRiskCount = 0
    for (const row of severityRows) {
      const count = Number(row.count)
      openRisksBySeverity[row.severity as RiskSeverity] = count
      openRiskCount += count
    }

    const latestReport = await trx
      .selectFrom('governance.status_reports')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('period_end', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()

    const decisionRows = await trx
      .selectFrom('governance.project_decisions')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('decided_at', 'desc')
      .orderBy('id', 'desc')
      .limit(RECENT_DECISION_LIMIT)
      .execute()

    return {
      projectId,
      openRisksBySeverity,
      openRiskCount,
      latestStatusReport: latestReport ? mapStatusReport(latestReport) : null,
      recentDecisions: decisionRows.map(mapProjectDecision)
    }
  })
}
