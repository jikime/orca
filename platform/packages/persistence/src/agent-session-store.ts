import { randomUUID } from 'node:crypto'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeKind,
  type ResourceChangeResourceType
} from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

// R5 slice 1: Control-Plane authority for AI execution tracking (doc 14 §R5, doc 19).
// The Control Plane owns the agent session, the append-only event log, and the projected
// turn timeline. ExecutionContext signing / SessionBinding crypto (anti-forgery) is s2/s3 —
// this slice binds a producer to a session by identity match, not signature.
// TODO(pie-r5): s2 verifies a signed ExecutionContext + SessionBinding before ingest.

export type AgentProvider = 'claude_code' | 'codex' | 'opencode' | 'other'
export type AgentSessionStatus = 'active' | 'closed' | 'terminated'
export type ResourceVisibility = 'internal' | 'project' | 'customer'
export type ResourceClassification = 'public' | 'internal' | 'project_confidential' | 'restricted'

export type AgentSession = {
  id: string
  organizationId: string
  workItemId: string | null
  provider: AgentProvider
  providerSessionId: string | null
  hostId: string
  launchId: string | null
  status: AgentSessionStatus
  visibility: ResourceVisibility
  classification: ResourceClassification
  createdBy: string
  version: number
  createdAt: string
  updatedAt: string
}

type AgentSessionRow = {
  id: string
  organization_id: string
  work_item_id: string | null
  provider: string
  provider_session_id: string | null
  host_id: string
  launch_id: string | null
  status: string
  visibility: string
  classification: string
  created_by: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapAgentSession(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workItemId: row.work_item_id,
    provider: row.provider as AgentProvider,
    providerSessionId: row.provider_session_id,
    hostId: row.host_id,
    launchId: row.launch_id,
    status: row.status as AgentSessionStatus,
    visibility: row.visibility as ResourceVisibility,
    classification: row.classification as ResourceClassification,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

/**
 * Emits an execution resource-change on the SAME outbox the delivery/chat/support verticals
 * use — the resourceType union was extended additively, so the Worker → Realtime path
 * delivers agent_session/agent_event/agent_turn invalidations with zero new transport code.
 */
export async function emitAgentExecutionChange(
  trx: Transaction<Database>,
  organizationId: string,
  resourceType: Extract<ResourceChangeResourceType, 'agent_session' | 'agent_event' | 'agent_turn'>,
  resourceId: string,
  version: number,
  changeKind: ResourceChangeKind
): Promise<void> {
  const outboxId = randomUUID()
  const occurredAt = new Date().toISOString()
  const cloudEvent = buildResourceChangeCloudEvent({
    organizationId,
    eventId: outboxId,
    resourceType,
    resourceId,
    changeKind,
    version,
    occurredAt
  })
  await trx
    .insertInto('operations.outbox_events')
    .values({
      id: outboxId,
      organization_id: organizationId,
      aggregate_type: resourceType,
      aggregate_id: resourceId,
      aggregate_version: version,
      event_type: cloudEvent.type,
      event_schema_version: 1,
      payload: JSON.stringify(cloudEvent),
      occurred_at: occurredAt,
      available_at: occurredAt
    })
    .execute()
}

export async function loadAgentSessionTx(
  trx: Transaction<Database>,
  sessionId: string
): Promise<AgentSession | null> {
  const row = await trx
    .selectFrom('execution.agent_sessions')
    .selectAll()
    .where('id', '=', sessionId)
    .executeTakeFirst()
  return row ? mapAgentSession(row) : null
}

export type CreateAgentSessionInput = {
  organizationId: string
  actorUserId: string
  provider: AgentProvider
  hostId: string
  workItemId?: string | null
  providerSessionId?: string | null
  launchId?: string | null
  visibility?: ResourceVisibility
  classification?: ResourceClassification
}

/**
 * Creates an agent session in status='active' and emits an agent_session `created`
 * invalidation, all in one tenant tx. The session is the anchor every ingested event
 * binds to (a batch cannot forge another org/session — its events must reference a
 * session that exists in THIS org).
 */
export async function createAgentSession(
  db: Kysely<Database>,
  input: CreateAgentSessionInput
): Promise<AgentSession> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const inserted = await trx
      .insertInto('execution.agent_sessions')
      .values({
        organization_id: input.organizationId,
        provider: input.provider,
        provider_session_id: input.providerSessionId ?? null,
        host_id: input.hostId,
        launch_id: input.launchId ?? null,
        work_item_id: input.workItemId ?? null,
        status: 'active',
        visibility: input.visibility ?? 'internal',
        classification: input.classification ?? 'internal',
        created_by: input.actorUserId
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const session = mapAgentSession(inserted)
    await emitAgentExecutionChange(
      trx,
      input.organizationId,
      'agent_session',
      session.id,
      session.version,
      'created'
    )
    return session
  })
}

/** Reads one agent session, org-scoped (RLS). */
export async function getAgentSession(
  db: Kysely<Database>,
  organizationId: string,
  sessionId: string
): Promise<AgentSession | null> {
  return withTenantTransaction(db, organizationId, (trx) => loadAgentSessionTx(trx, sessionId))
}
