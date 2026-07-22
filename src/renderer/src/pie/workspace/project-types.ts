export type ProjectResource = {
  id: string
  organizationId: string
  name: string
  summary: string | null
  status: 'planned' | 'active' | 'paused' | 'completed' | 'cancelled'
  version: number
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
}

export type ProjectStatusReportSummary = {
  id: string
  periodEnd: string
  overallStatus: 'green' | 'amber' | 'red'
  summary: string
}

export type ProjectDecisionSummary = {
  id: string
  title: string
  decision: string
  decidedAt: string
}

export type ProjectGovernanceSummary = {
  projectId: string
  openRisksBySeverity: Record<'low' | 'medium' | 'high' | 'critical', number>
  openRiskCount: number
  latestStatusReport: ProjectStatusReportSummary | null
  recentDecisions: ProjectDecisionSummary[]
}
