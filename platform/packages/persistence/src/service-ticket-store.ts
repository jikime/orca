import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import type { Audience } from './resource-projection'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeResourceType
} from './resource-change-event'
import {
  computeTicketDueAt,
  computeTicketSlaStatus,
  normalizePriority,
  resolveSlaTargets,
  type SlaTargets,
  type TicketPriority,
  type TicketSlaStatus
} from './service-sla'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 3: the service-ticket aggregate. A ticket belongs to a crm account (opaque account_id +
// reporter_contact_id), carries an SLA (due-at computed from the priority's policy at create), and
// splits customer-facing 공개 답변 from internal 내부 메모 via append-only replies. It REUSES the R5
// agent-session + R8 remote-session flows by recording their OPAQUE ids — no cross-schema FK, no
// re-creation of those sessions here (link-by-id only).

export type TicketStatus = 'new' | 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed'
export type ReplyKind = 'public_reply' | 'internal_memo'
export type ReplyVisibility = 'internal' | 'project' | 'customer'

export type TicketResource = {
  id: string
  organizationId: string
  accountId: string
  reporterContactId: string | null
  subject: string
  body: string
  status: TicketStatus
  priority: TicketPriority
  assigneeUserId: string | null
  projectId: string | null
  contractId: string | null
  agentSessionId: string | null
  remoteSessionId: string | null
  slaPolicyId: string | null
  firstResponseDueAt: string | null
  resolutionDueAt: string | null
  firstRespondedAt: string | null
  resolvedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type TicketReplyResource = {
  id: string
  organizationId: string
  ticketId: string
  kind: ReplyKind
  visibility: ReplyVisibility
  authorUserId: string
  body: string
  createdAt: string
}

export type SlaPolicyResource = {
  id: string
  organizationId: string
  name: string
  targets: SlaTargets
  isDefault: boolean
  version: number
  createdAt: string
  updatedAt: string
}

type TicketRow = {
  id: string
  organization_id: string
  account_id: string
  reporter_contact_id: string | null
  subject: string
  body: string
  status: string
  priority: string
  assignee_user_id: string | null
  project_id: string | null
  contract_id: string | null
  agent_session_id: string | null
  remote_session_id: string | null
  sla_policy_id: string | null
  first_response_due_at: Date | string | null
  resolution_due_at: Date | string | null
  first_responded_at: Date | string | null
  resolved_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null
}

function mapTicket(row: TicketRow): TicketResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    reporterContactId: row.reporter_contact_id,
    subject: row.subject,
    body: row.body,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    assigneeUserId: row.assignee_user_id,
    projectId: row.project_id,
    contractId: row.contract_id,
    agentSessionId: row.agent_session_id,
    remoteSessionId: row.remote_session_id,
    slaPolicyId: row.sla_policy_id,
    firstResponseDueAt: iso(row.first_response_due_at),
    resolutionDueAt: iso(row.resolution_due_at),
    firstRespondedAt: iso(row.first_responded_at),
    resolvedAt: iso(row.resolved_at),
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

function mapReply(row: {
  id: string
  organization_id: string
  ticket_id: string
  kind: string
  visibility: string
  author_user_id: string
  body: string
  created_at: Date | string
}): TicketReplyResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ticketId: row.ticket_id,
    kind: row.kind as ReplyKind,
    visibility: row.visibility as ReplyVisibility,
    authorUserId: row.author_user_id,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString()
  }
}

function mapPolicy(row: {
  id: string
  organization_id: string
  name: string
  targets: unknown
  is_default: boolean
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}): SlaPolicyResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    targets: resolveSlaTargets(row.targets),
    isDefault: row.is_default,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

async function emitServiceChange(
  trx: Transaction<Database>,
  organizationId: string,
  resourceType: ResourceChangeResourceType,
  resourceId: string,
  version: number,
  changeKind: 'created' | 'updated'
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

async function audit(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  action: string,
  targetId: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorUserId,
      action,
      target_type: 'service_ticket',
      target_id: targetId
    })
    .execute()
}

// Loads the effective SLA targets: the named policy, else the org's default policy, else the built-in
// DEFAULT_SLA_TARGETS. Returns the policy id actually used (null when falling back to built-ins).
async function resolveTargetsForCreate(
  trx: Transaction<Database>,
  slaPolicyId: string | null
): Promise<{ targets: SlaTargets; policyId: string | null }> {
  let policyRow = slaPolicyId
    ? await trx
        .selectFrom('service.sla_policies')
        .select(['id', 'targets'])
        .where('id', '=', slaPolicyId)
        .executeTakeFirst()
    : undefined
  if (!policyRow && !slaPolicyId) {
    policyRow = await trx
      .selectFrom('service.sla_policies')
      .select(['id', 'targets'])
      .where('is_default', '=', true)
      .orderBy('created_at', 'asc')
      .executeTakeFirst()
  }
  return policyRow
    ? { targets: resolveSlaTargets(policyRow.targets), policyId: policyRow.id }
    : { targets: resolveSlaTargets(undefined), policyId: null }
}

export type CreateSlaPolicyResult = { policy: SlaPolicyResource }

/** Creates an SLA policy (per-priority target minutes). When isDefault, it is cleared on every other
 *  policy first so at most one default per org — the create fallback picks it. */
export async function createSlaPolicy(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    name: string
    targets?: unknown
    isDefault?: boolean
  }
): Promise<CreateSlaPolicyResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    if (input.isDefault) {
      await trx
        .updateTable('service.sla_policies')
        .set({ is_default: false, updated_at: sql`now()` })
        .where('is_default', '=', true)
        .execute()
    }
    const row = await trx
      .insertInto('service.sla_policies')
      .values({
        organization_id: input.organizationId,
        name: input.name,
        targets: JSON.stringify(resolveSlaTargets(input.targets)),
        is_default: input.isDefault ?? false
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(trx, input.organizationId, input.actorUserId, 'service.sla_policy.created', row.id)
    return { policy: mapPolicy(row) }
  })
}

export async function listSlaPolicies(
  db: Kysely<Database>,
  organizationId: string
): Promise<SlaPolicyResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('service.sla_policies')
      .selectAll()
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapPolicy)
  })
}

export type CreateTicketResult =
  | { ok: true; ticket: TicketResource }
  | { ok: false; reason: 'account_not_found' }

/**
 * Creates a ticket in status='new' and computes first_response_due_at/resolution_due_at from the
 * priority's SLA policy (or the default) at create time — the SLA-due-from-policy rule. account_id is
 * an OPAQUE crm id; existence is verified (the account is readable under tenant context) but no FK.
 */
export async function createTicket(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    accountId: string
    reporterContactId?: string | null
    subject: string
    body?: string
    priority?: string
    assigneeUserId?: string | null
    projectId?: string | null
    contractId?: string | null
    slaPolicyId?: string | null
    now?: Date
  }
): Promise<CreateTicketResult> {
  const priority = normalizePriority(input.priority)
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const account = await trx
      .selectFrom('crm.accounts')
      .select('id')
      .where('id', '=', input.accountId)
      .executeTakeFirst()
    if (!account) {
      return { ok: false, reason: 'account_not_found' }
    }
    const createdAt = input.now ?? new Date()
    const { targets, policyId } = await resolveTargetsForCreate(trx, input.slaPolicyId ?? null)
    const due = computeTicketDueAt(createdAt, priority, targets)
    const row = await trx
      .insertInto('service.tickets')
      .values({
        organization_id: input.organizationId,
        account_id: input.accountId,
        reporter_contact_id: input.reporterContactId ?? null,
        subject: input.subject,
        body: input.body ?? '',
        status: 'new',
        priority,
        assignee_user_id: input.assigneeUserId ?? null,
        project_id: input.projectId ?? null,
        contract_id: input.contractId ?? null,
        sla_policy_id: policyId,
        first_response_due_at: due.firstResponseDueAt,
        resolution_due_at: due.resolutionDueAt
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(trx, input.organizationId, input.actorUserId, 'service.ticket.created', row.id)
    await emitServiceChange(trx, input.organizationId, 'service_ticket', row.id, 1, 'created')
    return { ok: true, ticket: mapTicket(row) }
  })
}

export async function getTicket(
  db: Kysely<Database>,
  organizationId: string,
  ticketId: string
): Promise<TicketResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('service.tickets')
      .selectAll()
      .where('id', '=', ticketId)
      .executeTakeFirst()
    return row ? mapTicket(row) : null
  })
}

export type TicketPage = { items: TicketResource[]; nextCursor: string | null }

/** Lists tickets, filterable by account, status, assignee, and (SLA-breach) unmet+overdue. The
 *  breach filter is evaluated against the injected `now` so it is deterministic in tests. */
export async function listTickets(
  db: Kysely<Database>,
  organizationId: string,
  options: {
    accountId?: string
    status?: string
    assigneeUserId?: string
    slaBreach?: boolean
    now?: Date
    limit?: number
    cursor?: string | null
  } = {}
): Promise<TicketPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const now = options.now ?? new Date()
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('service.tickets')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.accountId) {
      query = query.where('account_id', '=', options.accountId)
    }
    if (options.status) {
      query = query.where('status', '=', options.status)
    }
    if (options.assigneeUserId) {
      query = query.where('assignee_user_id', '=', options.assigneeUserId)
    }
    if (options.slaBreach) {
      // Breach = unmet AND overdue on EITHER response or resolution (mirrors slaPhase's `breached`).
      query = query.where((eb) =>
        eb.or([
          eb.and([
            eb('first_responded_at', 'is', null),
            eb('first_response_due_at', '<', now),
            eb('first_response_due_at', 'is not', null)
          ]),
          eb.and([
            eb('resolved_at', 'is', null),
            eb('resolution_due_at', '<', now),
            eb('resolution_due_at', 'is not', null)
          ])
        ])
      )
    }
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapTicket), nextCursor }
  })
}

export type TicketSlaRead = TicketSlaStatus & {
  ticketId: string
  firstResponseDueAt: string | null
  resolutionDueAt: string | null
  firstRespondedAt: string | null
  resolvedAt: string | null
}

/** The SLA-status read for one ticket: on_track|at_risk|breached for response and resolution,
 *  computed from the injected `now` via the pure service-sla calc. */
export async function getTicketSlaStatus(
  db: Kysely<Database>,
  organizationId: string,
  ticketId: string,
  now: Date = new Date()
): Promise<TicketSlaRead | null> {
  const ticket = await getTicket(db, organizationId, ticketId)
  if (!ticket) {
    return null
  }
  const status = computeTicketSlaStatus(now, {
    firstResponseDueAt: ticket.firstResponseDueAt ? new Date(ticket.firstResponseDueAt) : null,
    resolutionDueAt: ticket.resolutionDueAt ? new Date(ticket.resolutionDueAt) : null,
    firstRespondedAt: ticket.firstRespondedAt ? new Date(ticket.firstRespondedAt) : null,
    resolvedAt: ticket.resolvedAt ? new Date(ticket.resolvedAt) : null
  })
  return {
    ticketId,
    ...status,
    firstResponseDueAt: ticket.firstResponseDueAt,
    resolutionDueAt: ticket.resolutionDueAt,
    firstRespondedAt: ticket.firstRespondedAt,
    resolvedAt: ticket.resolvedAt
  }
}

// Legal status edges. An active ticket may move among the working states and to resolved/closed; a
// resolved/closed ticket may only reopen (→ open) or, from resolved, close. The store enforces this
// (a CHECK cannot see the prior value) exactly like remote-session/contract transitions.
const LEGAL_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ['open', 'pending', 'on_hold', 'resolved', 'closed'],
  open: ['pending', 'on_hold', 'resolved', 'closed'],
  pending: ['open', 'on_hold', 'resolved', 'closed'],
  on_hold: ['open', 'pending', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open']
}

export type TicketTransitionResult =
  | { ok: true; ticket: TicketResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: TicketStatus }

/** Transitions a ticket's status under OCC. Entering resolved/closed stamps resolved_at (once);
 *  reopening to an active state clears it so the resolution SLA recomputes. */
export async function transitionTicket(
  db: Kysely<Database>,
  input: {
    organizationId: string
    ticketId: string
    actorUserId: string
    toStatus: TicketStatus
    expectedVersion: number
    now?: Date
  }
): Promise<TicketTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('service.tickets')
      .selectAll()
      .where('id', '=', input.ticketId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as TicketStatus
    if (from === input.toStatus || !LEGAL_TRANSITIONS[from].includes(input.toStatus)) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const now = input.now ?? new Date()
    const entersDone = input.toStatus === 'resolved' || input.toStatus === 'closed'
    const reopens = input.toStatus === 'open'
    const resolvedAt = entersDone
      ? (current.resolved_at ?? now)
      : reopens
        ? null
        : (current.resolved_at ?? null)
    const updated = await trx
      .updateTable('service.tickets')
      .set({
        status: input.toStatus,
        resolved_at: resolvedAt,
        version: currentVersion + 1,
        updated_at: sql`now()`
      })
      .where('id', '=', input.ticketId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `service.ticket.transition.${input.toStatus}`,
      input.ticketId
    )
    await emitServiceChange(
      trx,
      input.organizationId,
      'service_ticket',
      input.ticketId,
      currentVersion + 1,
      'updated'
    )
    return { ok: true, ticket: mapTicket(updated) }
  })
}

export type AssignTicketResult =
  | { ok: true; ticket: TicketResource }
  | { ok: false; reason: 'not_found' }

/** Sets (or clears) the assignee (담당자). Bumps version + emits updated; not OCC-gated (assignment is
 *  idempotent enough that last-write-wins is acceptable, unlike a status transition). */
export async function assignTicket(
  db: Kysely<Database>,
  input: {
    organizationId: string
    ticketId: string
    actorUserId: string
    assigneeUserId: string | null
  }
): Promise<AssignTicketResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('service.tickets')
      .select(['id', 'version'])
      .where('id', '=', input.ticketId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const newVersion = Number(current.version) + 1
    const updated = await trx
      .updateTable('service.tickets')
      .set({
        assignee_user_id: input.assigneeUserId,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.ticketId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'service.ticket.assigned',
      input.ticketId
    )
    await emitServiceChange(
      trx,
      input.organizationId,
      'service_ticket',
      input.ticketId,
      newVersion,
      'updated'
    )
    return { ok: true, ticket: mapTicket(updated) }
  })
}

export type AddReplyResult =
  | { ok: true; reply: TicketReplyResource; ticket: TicketResource }
  | { ok: false; reason: 'not_found' }

/**
 * Appends a reply. A public_reply is customer-visible (visibility='customer'); an internal_memo is
 * internal-only (visibility='internal') — kept CONSISTENT here so a customer read can filter on either
 * column. The FIRST public_reply stamps first_responded_at (once), moving the response SLA to met.
 */
export async function addReply(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    ticketId: string
    kind: ReplyKind
    body: string
    now?: Date
  }
): Promise<AddReplyResult> {
  const visibility: ReplyVisibility = input.kind === 'public_reply' ? 'customer' : 'internal'
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('service.tickets')
      .selectAll()
      .where('id', '=', input.ticketId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const reply = await trx
      .insertInto('service.ticket_replies')
      .values({
        organization_id: input.organizationId,
        ticket_id: input.ticketId,
        kind: input.kind,
        visibility,
        author_user_id: input.actorUserId,
        body: input.body
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const now = input.now ?? new Date()
    const stampsFirstResponse = input.kind === 'public_reply' && !current.first_responded_at
    const newVersion = Number(current.version) + 1
    const updated = await trx
      .updateTable('service.tickets')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(stampsFirstResponse ? { first_responded_at: now } : {})
      })
      .where('id', '=', input.ticketId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `service.ticket.${input.kind}`,
      input.ticketId
    )
    await emitServiceChange(
      trx,
      input.organizationId,
      'service_ticket_reply',
      reply.id,
      1,
      'created'
    )
    await emitServiceChange(
      trx,
      input.organizationId,
      'service_ticket',
      input.ticketId,
      newVersion,
      'updated'
    )
    return { ok: true, reply: mapReply(reply), ticket: mapTicket(updated) }
  })
}

/**
 * Lists a ticket's replies oldest-first, SCOPED to the caller's audience. An EXTERNAL (customer)
 * audience sees only public_reply rows — the internal_memo rows are excluded IN THE QUERY (a WHERE
 * filter), so an internal memo is absent from the list, its count, and any preview, never merely
 * hidden after fetch. An internal audience sees both kinds.
 */
export async function listReplies(
  db: Kysely<Database>,
  organizationId: string,
  ticketId: string,
  options: { audience: Audience }
): Promise<TicketReplyResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('service.ticket_replies')
      .selectAll()
      .where('ticket_id', '=', ticketId)
    if (options.audience === 'external') {
      query = query.where('kind', '=', 'public_reply')
    }
    const rows = await query.orderBy('created_at', 'asc').orderBy('id', 'asc').execute()
    return rows.map(mapReply)
  })
}

export type LinkSessionResult =
  | { ok: true; ticket: TicketResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'session_not_found' }

/**
 * The R5/R8 REUSE-BY-LINK. Records an OPAQUE agent-session (R5 Workspace/AgentSession) or remote-
 * session (R8) id on the ticket so the existing execution/provenance + remote-support flows are
 * reachable FROM the ticket. The session is created by its OWN flow — this only verifies the id
 * resolves in-tenant (no cross-schema FK) and stores it. Bumps version + emits updated.
 */
export async function linkSession(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    ticketId: string
    kind: 'agent_session' | 'remote_session'
    sessionId: string
  }
): Promise<LinkSessionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('service.tickets')
      .select(['id', 'version'])
      .where('id', '=', input.ticketId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    // Verify the opaque id resolves in this tenant (readable under tenant context) — integrity
    // without a cross-schema FK.
    const session =
      input.kind === 'agent_session'
        ? await trx
            .selectFrom('execution.agent_sessions')
            .select('id')
            .where('id', '=', input.sessionId)
            .executeTakeFirst()
        : await trx
            .selectFrom('support.remote_sessions')
            .select('id')
            .where('id', '=', input.sessionId)
            .executeTakeFirst()
    if (!session) {
      return { ok: false, reason: 'session_not_found' }
    }
    const newVersion = Number(current.version) + 1
    const updated = await trx
      .updateTable('service.tickets')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.kind === 'agent_session'
          ? { agent_session_id: input.sessionId }
          : { remote_session_id: input.sessionId })
      })
      .where('id', '=', input.ticketId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `service.ticket.linked.${input.kind}`,
      input.ticketId
    )
    await emitServiceChange(
      trx,
      input.organizationId,
      'service_ticket',
      input.ticketId,
      newVersion,
      'updated'
    )
    return { ok: true, ticket: mapTicket(updated) }
  })
}
