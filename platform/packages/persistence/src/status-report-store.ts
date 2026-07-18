import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditGovernanceEvent, emitGovernanceResourceChange } from './governance-resource-events'
import { toDateString } from './planning-date'
import { withTenantTransaction } from './tenant-transaction'

// R6 governance — a periodic project STATUS report. overall_status is green|amber|red over the
// window [period_start, period_end]. project_id / reported_by are OPAQUE ids — no FK. version is OCC.

export type OverallStatus = 'green' | 'amber' | 'red'

export type StatusReportResource = {
  id: string
  organizationId: string
  projectId: string
  periodStart: string
  periodEnd: string
  overallStatus: OverallStatus
  summary: string
  highlights: string | null
  risksSummary: string | null
  nextSteps: string | null
  reportedBy: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type StatusReportRow = {
  id: string
  organization_id: string
  project_id: string
  period_start: Date | string
  period_end: Date | string
  overall_status: string
  summary: string
  highlights: string | null
  risks_summary: string | null
  next_steps: string | null
  reported_by: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapStatusReport(row: StatusReportRow): StatusReportResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    // period_start/period_end are NOT NULL; toDateString never returns null for a real row.
    periodStart: toDateString(row.period_start) ?? '',
    periodEnd: toDateString(row.period_end) ?? '',
    overallStatus: row.overall_status as OverallStatus,
    summary: row.summary,
    highlights: row.highlights,
    risksSummary: row.risks_summary,
    nextSteps: row.next_steps,
    reportedBy: row.reported_by,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateStatusReportInput = {
  organizationId: string
  actorUserId: string
  projectId: string
  periodStart: string
  periodEnd: string
  overallStatus?: OverallStatus
  summary: string
  highlights?: string | null
  risksSummary?: string | null
  nextSteps?: string | null
}

/** Creates a status report for a reporting window. reported_by records the actor. */
export async function createStatusReport(
  db: Kysely<Database>,
  input: CreateStatusReportInput
): Promise<StatusReportResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('governance.status_reports')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        overall_status: input.overallStatus ?? 'green',
        summary: input.summary,
        highlights: input.highlights ?? null,
        risks_summary: input.risksSummary ?? null,
        next_steps: input.nextSteps ?? null,
        reported_by: input.actorUserId
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditGovernanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'status_report.created',
      'status_report',
      row.id
    )
    await emitGovernanceResourceChange(
      trx,
      input.organizationId,
      'status_report',
      row.id,
      1,
      'created'
    )
    return mapStatusReport(row)
  })
}

export async function getStatusReport(
  db: Kysely<Database>,
  organizationId: string,
  statusReportId: string
): Promise<StatusReportResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('governance.status_reports')
      .selectAll()
      .where('id', '=', statusReportId)
      .executeTakeFirst()
    return row ? mapStatusReport(row) : null
  })
}

export type StatusReportPage = { items: StatusReportResource[]; nextCursor: string | null }

// Ordered by period_end DESC (most recent reporting window first), tie-broken by id.
export async function listStatusReportsByProject(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<StatusReportPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('governance.status_reports')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('period_end', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '<', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapStatusReport), nextCursor }
  })
}

export type UpdateStatusReportResult =
  | { ok: true; statusReport: StatusReportResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export type UpdateStatusReportInput = {
  organizationId: string
  statusReportId: string
  actorUserId: string
  expectedVersion: number
  overallStatus?: OverallStatus
  summary?: string
  highlights?: string | null
  risksSummary?: string | null
  nextSteps?: string | null
  periodStart?: string
  periodEnd?: string
}

/** Edits a status report under OCC (If-Match). */
export async function updateStatusReport(
  db: Kysely<Database>,
  input: UpdateStatusReportInput
): Promise<UpdateStatusReportResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('governance.status_reports')
      .selectAll()
      .where('id', '=', input.statusReportId)
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
      .updateTable('governance.status_reports')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.overallStatus === undefined ? {} : { overall_status: input.overallStatus }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.highlights === undefined ? {} : { highlights: input.highlights }),
        ...(input.risksSummary === undefined ? {} : { risks_summary: input.risksSummary }),
        ...(input.nextSteps === undefined ? {} : { next_steps: input.nextSteps }),
        ...(input.periodStart === undefined ? {} : { period_start: input.periodStart }),
        ...(input.periodEnd === undefined ? {} : { period_end: input.periodEnd })
      })
      .where('id', '=', input.statusReportId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditGovernanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'status_report.updated',
      'status_report',
      updated.id
    )
    await emitGovernanceResourceChange(
      trx,
      input.organizationId,
      'status_report',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, statusReport: mapStatusReport(updated) }
  })
}
