import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditGovernanceEvent, emitGovernanceResourceChange } from './governance-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R6 governance — a project DECISION log entry. Append-oriented: a decision is never edited in place;
// a superseding decision is a NEW row referencing the one it replaces via supersedes_id. project_id /
// decided_by / related_risk_id / supersedes_id are OPAQUE same-tenant ids — no FK, so a superseded
// decision is never cascaded away.

export type ProjectDecisionResource = {
  id: string
  organizationId: string
  projectId: string
  title: string
  context: string | null
  decision: string
  rationale: string | null
  decidedBy: string | null
  decidedAt: string
  relatedRiskId: string | null
  supersedesId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type ProjectDecisionRow = {
  id: string
  organization_id: string
  project_id: string
  title: string
  context: string | null
  decision: string
  rationale: string | null
  decided_by: string | null
  decided_at: Date | string
  related_risk_id: string | null
  supersedes_id: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapProjectDecision(row: ProjectDecisionRow): ProjectDecisionResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    title: row.title,
    context: row.context,
    decision: row.decision,
    rationale: row.rationale,
    decidedBy: row.decided_by,
    decidedAt: new Date(row.decided_at).toISOString(),
    relatedRiskId: row.related_risk_id,
    supersedesId: row.supersedes_id,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateProjectDecisionInput = {
  organizationId: string
  actorUserId: string
  projectId: string
  title: string
  context?: string | null
  decision: string
  rationale?: string | null
  relatedRiskId?: string | null
  supersedesId?: string | null
}

/**
 * Appends a decision. decided_by records the actor and decided_at defaults to now(). A superseding
 * decision passes supersedes_id pointing at the prior decision — the supersedes-chain that lets the
 * log stay append-only while still expressing "this replaces that".
 */
export async function createProjectDecision(
  db: Kysely<Database>,
  input: CreateProjectDecisionInput
): Promise<ProjectDecisionResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('governance.project_decisions')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        title: input.title,
        context: input.context ?? null,
        decision: input.decision,
        rationale: input.rationale ?? null,
        decided_by: input.actorUserId,
        related_risk_id: input.relatedRiskId ?? null,
        supersedes_id: input.supersedesId ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditGovernanceEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'project_decision.created',
      'project_decision',
      row.id
    )
    await emitGovernanceResourceChange(
      trx,
      input.organizationId,
      'project_decision',
      row.id,
      1,
      'created'
    )
    return mapProjectDecision(row)
  })
}

export async function getProjectDecision(
  db: Kysely<Database>,
  organizationId: string,
  decisionId: string
): Promise<ProjectDecisionResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('governance.project_decisions')
      .selectAll()
      .where('id', '=', decisionId)
      .executeTakeFirst()
    return row ? mapProjectDecision(row) : null
  })
}

export type ProjectDecisionPage = { items: ProjectDecisionResource[]; nextCursor: string | null }

// Ordered by decided_at DESC (newest first), tie-broken by id, so the most recent decision — the head
// of any supersedes-chain — leads. Cursor pages by (decided_at, id) to stay stable across ties.
export async function listProjectDecisionsByProject(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<ProjectDecisionPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('governance.project_decisions')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('decided_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '<', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapProjectDecision), nextCursor }
  })
}
