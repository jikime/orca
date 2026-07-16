import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

export type WorkflowCategory =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled'

export type WorkflowStateResource = {
  id: string
  organizationId: string
  teamId: string
  key: string
  name: string
  category: WorkflowCategory
  sortKey: number
}

// The default WorkItem Workflow every team is born with (doc 27:137, team lead
// spec: Todo→In Progress→Review→Done mapped onto the fixed categories). New work
// items start in the lowest-sort_key state (todo). This is the Team WorkItem
// Workflow only — NOT the Project Delivery Workflow.
export const DEFAULT_WORKFLOW_STATES: ReadonlyArray<{
  key: string
  name: string
  category: WorkflowCategory
  sortKey: number
}> = [
  { key: 'todo', name: 'Todo', category: 'unstarted', sortKey: 1 },
  { key: 'in_progress', name: 'In Progress', category: 'started', sortKey: 2 },
  { key: 'review', name: 'In Review', category: 'started', sortKey: 3 },
  { key: 'done', name: 'Done', category: 'completed', sortKey: 4 }
]

function mapWorkflowState(row: {
  id: string
  organization_id: string
  team_id: string
  key: string
  name: string
  category: string
  sort_key: string | number
}): WorkflowStateResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    teamId: row.team_id,
    key: row.key,
    name: row.name,
    category: row.category as WorkflowCategory,
    sortKey: Number(row.sort_key)
  }
}

/**
 * Seeds a team's default WorkItem Workflow inside an existing transaction. Called
 * by team creation (insertTeamRow) so EVERY team — default-provisioned or
 * explicitly created — is born with a workflow, in the same one tx.
 */
export async function seedDefaultWorkflow(
  trx: Transaction<Database>,
  organizationId: string,
  teamId: string
): Promise<void> {
  await trx
    .insertInto('delivery.workflow_states')
    .values(
      DEFAULT_WORKFLOW_STATES.map((state) => ({
        organization_id: organizationId,
        team_id: teamId,
        key: state.key,
        name: state.name,
        category: state.category,
        sort_key: state.sortKey
      }))
    )
    .execute()
}

/** The team's initial WorkItem state (lowest sort_key) — the create default. */
export async function defaultStateIdForTeam(
  trx: Transaction<Database>,
  teamId: string
): Promise<string | null> {
  const row = await trx
    .selectFrom('delivery.workflow_states')
    .select('id')
    .where('team_id', '=', teamId)
    .orderBy('sort_key')
    .limit(1)
    .executeTakeFirst()
  return row?.id ?? null
}

export type TeamWorkflow = {
  states: WorkflowStateResource[]
  // Bumped on any state-set change; a board move sends this and is rejected 412
  // if the team's workflow moved on underneath it.
  workflowVersion: number
}

/** Lists a team's workflow states + current workflowVersion, or null if no team. */
export async function listTeamWorkflow(
  db: Kysely<Database>,
  organizationId: string,
  teamId: string
): Promise<TeamWorkflow | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const team = await trx
      .selectFrom('delivery.teams')
      .select('workflow_version')
      .where('id', '=', teamId)
      .executeTakeFirst()
    if (!team) {
      return null
    }
    const rows = await trx
      .selectFrom('delivery.workflow_states')
      .selectAll()
      .where('team_id', '=', teamId)
      .orderBy('sort_key')
      .execute()
    return { states: rows.map(mapWorkflowState), workflowVersion: Number(team.workflow_version) }
  })
}

export type AddWorkflowStateResult =
  | { ok: true; state: WorkflowStateResource; workflowVersion: number }
  | { ok: false; reason: 'team_not_found' | 'key_taken' }

/**
 * Adds a state to a team's workflow and bumps the team's workflow_version — the
 * state-set change that invalidates in-flight board moves. Adding (never deleting)
 * keeps existing work-item state FKs valid; state removal with a remap is a later
 * slice (doc 27:134).
 */
export async function addWorkflowState(
  db: Kysely<Database>,
  input: {
    organizationId: string
    teamId: string
    actorUserId: string
    key: string
    name: string
    category: WorkflowCategory
    sortKey: number
  }
): Promise<AddWorkflowStateResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const team = await trx
      .selectFrom('delivery.teams')
      .select('id')
      .where('id', '=', input.teamId)
      .forUpdate()
      .executeTakeFirst()
    if (!team) {
      return { ok: false, reason: 'team_not_found' }
    }
    const existing = await trx
      .selectFrom('delivery.workflow_states')
      .select('id')
      .where('team_id', '=', input.teamId)
      .where('key', '=', input.key)
      .executeTakeFirst()
    if (existing) {
      return { ok: false, reason: 'key_taken' }
    }
    const state = await trx
      .insertInto('delivery.workflow_states')
      .values({
        organization_id: input.organizationId,
        team_id: input.teamId,
        key: input.key,
        name: input.name,
        category: input.category,
        sort_key: input.sortKey
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const bumped = await trx
      .updateTable('delivery.teams')
      .set({ workflow_version: sql`workflow_version + 1`, updated_at: sql`now()` })
      .where('id', '=', input.teamId)
      .returning('workflow_version')
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'workflow.state_added',
        target_type: 'team',
        target_id: input.teamId
      })
      .execute()
    return {
      ok: true,
      state: mapWorkflowState(state),
      workflowVersion: Number(bumped.workflow_version)
    }
  })
}
