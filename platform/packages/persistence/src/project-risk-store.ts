import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditGovernanceEvent, emitGovernanceResourceChange } from './governance-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R6 governance — a project RISK register entry. severity is DERIVED from probability × impact and
// STORED, computed on write so the wire never trusts a caller-supplied severity. status walks
// open → mitigating → closed|accepted (a status change is the OCC :transition). project_id /
// owner_user_id are OPAQUE cross-schema ids — no FK, same-tenant integrity via organization_id.

export type RiskLevel = 'low' | 'medium' | 'high'
export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical'
export type RiskCategory = 'schedule' | 'budget' | 'technical' | 'resource' | 'external'
export type RiskStatus = 'open' | 'mitigating' | 'closed' | 'accepted'
export type RiskAction = 'mitigate' | 'close' | 'accept' | 'reopen'

// severity-computed-on-write: a 3×3 probability×impact matrix (low=1, medium=2, high=3) scored by
// product, so high×high (9) ⇒ critical and low×low (1) ⇒ low. The single source of severity truth.
const LEVEL_WEIGHT: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 }

export function computeRiskSeverity(probability: RiskLevel, impact: RiskLevel): RiskSeverity {
  const score = LEVEL_WEIGHT[probability] * LEVEL_WEIGHT[impact]
  if (score <= 2) return 'low'
  if (score <= 4) return 'medium'
  if (score <= 6) return 'high'
  return 'critical'
}

export type ProjectRiskResource = {
  id: string
  organizationId: string
  projectId: string
  title: string
  description: string | null
  category: RiskCategory
  probability: RiskLevel
  impact: RiskLevel
  severity: RiskSeverity
  status: RiskStatus
  mitigation: string | null
  ownerUserId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type ProjectRiskRow = {
  id: string
  organization_id: string
  project_id: string
  title: string
  description: string | null
  category: string
  probability: string
  impact: string
  severity: string
  status: string
  mitigation: string | null
  owner_user_id: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapProjectRisk(row: ProjectRiskRow): ProjectRiskResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    category: row.category as RiskCategory,
    probability: row.probability as RiskLevel,
    impact: row.impact as RiskLevel,
    severity: row.severity as RiskSeverity,
    status: row.status as RiskStatus,
    mitigation: row.mitigation,
    ownerUserId: row.owner_user_id,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateProjectRiskInput = {
  organizationId: string
  actorUserId: string
  projectId: string
  title: string
  description?: string | null
  category?: RiskCategory
  probability?: RiskLevel
  impact?: RiskLevel
  mitigation?: string | null
  ownerUserId?: string | null
}

/** Creates a risk in status='open' with severity computed from probability × impact. */
export async function createProjectRisk(
  db: Kysely<Database>,
  input: CreateProjectRiskInput
): Promise<ProjectRiskResource> {
  const probability = input.probability ?? 'medium'
  const impact = input.impact ?? 'medium'
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('governance.project_risks')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        title: input.title,
        description: input.description ?? null,
        category: input.category ?? 'technical',
        probability,
        impact,
        severity: computeRiskSeverity(probability, impact),
        status: 'open',
        mitigation: input.mitigation ?? null,
        owner_user_id: input.ownerUserId ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditGovernanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'project_risk.created',
      'project_risk',
      row.id
    )
    await emitGovernanceResourceChange(
      trx,
      input.organizationId,
      'project_risk',
      row.id,
      1,
      'created'
    )
    return mapProjectRisk(row)
  })
}

export async function getProjectRisk(
  db: Kysely<Database>,
  organizationId: string,
  riskId: string
): Promise<ProjectRiskResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('governance.project_risks')
      .selectAll()
      .where('id', '=', riskId)
      .executeTakeFirst()
    return row ? mapProjectRisk(row) : null
  })
}

export type ProjectRiskPage = { items: ProjectRiskResource[]; nextCursor: string | null }

export async function listProjectRisksByProject(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<ProjectRiskPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('governance.project_risks')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapProjectRisk), nextCursor }
  })
}

export type UpdateProjectRiskResult =
  | { ok: true; risk: ProjectRiskResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export type UpdateProjectRiskInput = {
  organizationId: string
  riskId: string
  actorUserId: string
  expectedVersion: number
  title?: string
  description?: string | null
  category?: RiskCategory
  probability?: RiskLevel
  impact?: RiskLevel
  mitigation?: string | null
  ownerUserId?: string | null
}

/** Edits risk metadata under OCC. Recomputes severity whenever probability or impact changes. */
export async function updateProjectRisk(
  db: Kysely<Database>,
  input: UpdateProjectRiskInput
): Promise<UpdateProjectRiskResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('governance.project_risks')
      .selectAll()
      .where('id', '=', input.riskId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const probability = input.probability ?? (current.probability as RiskLevel)
    const impact = input.impact ?? (current.impact as RiskLevel)
    // severity-computed-on-write: re-derive whenever either factor is in the update.
    const severityChanged = input.probability !== undefined || input.impact !== undefined
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('governance.project_risks')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.probability === undefined ? {} : { probability }),
        ...(input.impact === undefined ? {} : { impact }),
        ...(severityChanged ? { severity: computeRiskSeverity(probability, impact) } : {}),
        ...(input.mitigation === undefined ? {} : { mitigation: input.mitigation }),
        ...(input.ownerUserId === undefined ? {} : { owner_user_id: input.ownerUserId })
      })
      .where('id', '=', input.riskId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditGovernanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'project_risk.updated',
      'project_risk',
      updated.id
    )
    await emitGovernanceResourceChange(
      trx,
      input.organizationId,
      'project_risk',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, risk: mapProjectRisk(updated) }
  })
}

export type ProjectRiskTransitionResult =
  | { ok: true; risk: ProjectRiskResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: RiskStatus }

// Legal status edges: open → mitigating (mitigate); open|mitigating → closed (close) | accepted
// (accept); closed|accepted → open (reopen). closed/accepted are terminal until reopened.
const LEGAL_FROMS: Record<RiskAction, RiskStatus[]> = {
  mitigate: ['open'],
  close: ['open', 'mitigating'],
  accept: ['open', 'mitigating'],
  reopen: ['closed', 'accepted']
}
const TO_STATUS: Record<RiskAction, RiskStatus> = {
  mitigate: 'mitigating',
  close: 'closed',
  accept: 'accepted',
  reopen: 'open'
}

/** Advances a risk's status under OCC (If-Match). */
export async function transitionProjectRisk(
  db: Kysely<Database>,
  input: {
    organizationId: string
    riskId: string
    actorUserId: string
    action: RiskAction
    expectedVersion: number
  }
): Promise<ProjectRiskTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('governance.project_risks')
      .selectAll()
      .where('id', '=', input.riskId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as RiskStatus
    if (!LEGAL_FROMS[input.action].includes(from)) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('governance.project_risks')
      .set({ status: TO_STATUS[input.action], version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.riskId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditGovernanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `project_risk.${input.action}`,
      'project_risk',
      input.riskId
    )
    await emitGovernanceResourceChange(
      trx,
      input.organizationId,
      'project_risk',
      input.riskId,
      newVersion,
      'updated'
    )
    return { ok: true, risk: mapProjectRisk(updated) }
  })
}
