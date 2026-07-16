import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'
import { seedDefaultWorkflow } from './workflow-store'

export const DEFAULT_TEAM_KEY = 'CORE'

export type TeamResource = {
  id: string
  organizationId: string
  key: string
  name: string
  version: number
  workflowVersion: number
  createdAt: string
  updatedAt: string
}

function mapTeam(row: {
  id: string
  organization_id: string
  key: string
  name: string
  version: string | number
  workflow_version: string | number
  created_at: Date | string
  updated_at: Date | string
}): TeamResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    key: row.key,
    name: row.name,
    version: Number(row.version),
    workflowVersion: Number(row.workflow_version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

/**
 * Inserts a team + its WorkItem sequence counter + default WorkItem Workflow inside
 * an existing transaction. Shared by createTeam and by owner provisioning's
 * default-team bootstrap, so every team is born with a workflow in the same one tx.
 */
export async function insertTeamRow(
  trx: Transaction<Database>,
  input: { organizationId: string; key: string; name: string }
): Promise<TeamResource> {
  const team = await trx
    .insertInto('delivery.teams')
    .values({ organization_id: input.organizationId, key: input.key, name: input.name })
    .returningAll()
    .executeTakeFirstOrThrow()
  await trx
    .insertInto('delivery.team_counters')
    .values({ organization_id: input.organizationId, team_id: team.id })
    .execute()
  await seedDefaultWorkflow(trx, input.organizationId, team.id)
  return mapTeam(team)
}

export type CreateTeamResult =
  | { ok: true; team: TeamResource }
  // The team key is already taken in this org (keys are org-unique).
  | { ok: false; reason: 'key_taken' }

export async function createTeam(
  db: Kysely<Database>,
  input: { organizationId: string; actorUserId: string; key: string; name: string }
): Promise<CreateTeamResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const existing = await trx
      .selectFrom('delivery.teams')
      .select('id')
      .where('key', '=', input.key)
      .executeTakeFirst()
    if (existing) {
      return { ok: false, reason: 'key_taken' }
    }
    const team = await insertTeamRow(trx, input)
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'team.created',
        target_type: 'team',
        target_id: team.id
      })
      .execute()
    return { ok: true, team }
  })
}

export async function getTeam(
  db: Kysely<Database>,
  organizationId: string,
  teamId: string
): Promise<TeamResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('delivery.teams')
      .selectAll()
      .where('id', '=', teamId)
      .executeTakeFirst()
    return row ? mapTeam(row) : null
  })
}

export async function listTeams(
  db: Kysely<Database>,
  organizationId: string
): Promise<TeamResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx.selectFrom('delivery.teams').selectAll().orderBy('key').execute()
    return rows.map(mapTeam)
  })
}
