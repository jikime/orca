// Wire shapes for the resource-change vertical. The outbox stores a CloudEvents
// 1.0 envelope (doc 23); the Realtime `resource.changed` message + the /changes
// feed item are the smaller invalidation view derived from it, carrying an
// opaque cursor that encodes the per-org publish sequence.

export type ResourceChangeKind = 'created' | 'updated' | 'archived' | 'deleted'

export type ResourceChangeResourceType =
  | 'organization'
  | 'membership'
  | 'team'
  | 'project'
  | 'work_item'
  | 'artifact'
  | 'agent_session'
  | 'operation'
  | 'permission'
  // Collaboration (chat). Additive to the generic outbox → Worker → gateway path,
  // so channel/message invalidations ride the existing transport with no new code.
  | 'channel'
  | 'channel_member'
  | 'message'
  | 'read_cursor'
  | 'notification'
  // RemoteSession (R8 slice A1). Additive to the same outbox → Worker → gateway path, so
  // session lifecycle invalidations ride the existing transport with no new code.
  | 'remote_session'
  // Agent execution tracking (R5 slice 1). Additive to the same outbox → Worker → gateway
  // path — event-batch ingest and turn finalization ride the existing transport unchanged.
  | 'agent_event'
  | 'agent_turn'
  // Provenance projection (R5 slice 4a). Commit/PR-MR/test/build/artifact/file-change
  // evidence invalidations ride the same transport unchanged.
  | 'agent_provenance'
  // Unassigned-session intake queue (R5 slice 4b). Intake create + assign/reclassify/dismiss
  // invalidations ride the same transport so the queue updates live.
  | 'agent_session_intake'
  // CRM / contract core (R6 slice 1). Additive to the same outbox → Worker → gateway path, so
  // account/opportunity/contract/change-order invalidations ride the existing transport with no
  // new worker/gateway code.
  | 'crm_account'
  | 'crm_opportunity'
  | 'crm_contract'
  | 'crm_change_order'
  // Requirements + traceability (R6 slice 2). Requirement lifecycle + acceptance invalidations ride
  // the same outbox → Worker → gateway path unchanged.
  | 'requirement'
  | 'requirement_acceptance'
  // Service tickets + SLA (R6 slice 3). Ticket lifecycle + reply (public/internal) invalidations ride
  // the same outbox → Worker → gateway path unchanged.
  | 'service_ticket'
  | 'service_ticket_reply'
  // Planning: WBS + milestones + schedule baselines (R6 slice 4). Node move/edit, milestone
  // transitions, and baseline captures ride the same outbox → Worker → gateway path unchanged.
  | 'wbs_node'
  | 'milestone'
  | 'schedule_baseline'
  // Planning: resource allocation + actual effort (R6 slice 5). Assignment create/update and
  // append-only effort-entry logs ride the same outbox → Worker → gateway path unchanged.
  | 'resource_assignment'
  | 'effort_entry'
  // External import (R6 slice 6). Import-run lifecycle invalidations ride the same outbox → Worker →
  // gateway path unchanged; the created/updated projects & work_items already emit their own changes.
  | 'import_run'
  // Project-execution change requests (R6). Change-request lifecycle (submit/approve/reject/apply)
  // invalidations ride the same outbox → Worker → gateway path unchanged.
  | 'change_request'
  // QA: deliverables + test cases + defects (R6). Deliverable accept, test_case pass/fail, and defect
  // status transitions ride the same outbox → Worker → gateway path unchanged.
  | 'deliverable'
  | 'test_case'
  | 'defect'
  // Project governance (R6). Risk register, decision log, and periodic status-report invalidations
  // ride the same outbox → Worker → gateway path unchanged.
  | 'project_risk'
  | 'project_decision'
  | 'status_report'
  // Knowledge base (R7). Article lifecycle (create/update/transition/review) invalidations ride the
  // same outbox → Worker → gateway path unchanged.
  | 'knowledge_article'
  // Automation (R7). Approval-gated runbook definitions, their executions (approve/run/complete/
  // rollback), and work-queue items ride the same outbox → Worker → gateway path unchanged.
  | 'runbook'
  | 'runbook_execution'
  | 'work_queue_item'
  // AI governance (R7). Per-org AI resource entitlement changes, append-only evaluation records, and
  // append-only prompt-injection/safety guard events ride the same outbox → Worker → gateway path
  // unchanged (quota_usage counters are not a realtime resource type — they are enforcement state).
  | 'ai_entitlement'
  | 'ai_evaluation'
  | 'ai_guard_event'
  // Meetings (R7). Meeting lifecycle, participant/consent, recording-ref, transcript, and AI/human
  // minutes invalidations ride the same outbox → Worker → gateway path unchanged (the media plane —
  // LiveKit/WebRTC transport — is infra and emits no control-plane resource change).
  | 'meeting'
  | 'meeting_participant'
  | 'meeting_recording'
  | 'meeting_transcript'
  | 'meeting_minutes'
  | 'meeting_agenda_item'
  | 'meeting_decision'
  | 'meeting_action_item'
  | 'meeting_capture_consent'
  | 'meeting_governance'
  // Asset registry / CMDB (R8). Asset lifecycle (create/update/transition/assign), CMDB link
  // create/delete, and append-only lifecycle-event invalidations ride the same outbox → Worker →
  // gateway path unchanged.
  | 'asset'
  | 'asset_link'
  | 'asset_event'
  // Finance (R9). Invoice lifecycle (create/update/issue/void), line-item add/remove (which recompute
  // the parent invoice totals), and append-only payment records ride the same outbox → Worker →
  // gateway path unchanged.
  | 'invoice'
  | 'invoice_line_item'
  | 'payment'

export type ResourceChangeData = {
  eventId: string
  resourceType: ResourceChangeResourceType
  resourceId: string
  changeKind: ResourceChangeKind
  version: number
  occurredAt: string
}

// CloudEvents 1.0 structured envelope with Pie extensions. piesequence is added
// at publish time (from the row's assigned stream_sequence); it is NOT known when
// the envelope is first written in the mutation transaction.
export type ResourceChangeCloudEvent = {
  specversion: '1.0'
  id: string
  source: string
  type: string
  subject: string
  time: string
  datacontenttype: 'application/json'
  pieorgid: string
  piestream: string
  // W3C Trace Context (doc 23:46) carried as the CloudEvents distributed-tracing
  // extension, so a request is traceable from mutation through Worker to gateway.
  traceparent?: string
  // occurredAt lives in the envelope `time`; eventId is the envelope `id`.
  data: Omit<ResourceChangeData, 'eventId' | 'occurredAt'>
}

const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/

/** Extracts the 32-hex trace-id from a W3C traceparent (for log correlation). */
export function traceIdFromTraceparent(traceparent: string | undefined): string | null {
  if (!traceparent) {
    return null
  }
  const match = TRACEPARENT_PATTERN.exec(traceparent)
  const traceId = match?.[1]
  return traceId && !/^0+$/.test(traceId) ? traceId : null
}

/** Reads the traceparent extension from a stored outbox payload, if present. */
export function traceparentFromPayload(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const value = (payload as { traceparent?: unknown }).traceparent
    if (typeof value === 'string') {
      return value
    }
  }
  return undefined
}

export type ResourceChangedMessage = {
  type: 'resource.changed'
  schemaVersion: 1
  eventId: string
  cursor: string
  organizationId: string
  resourceType: ResourceChangeResourceType
  resourceId: string
  changeKind: ResourceChangeKind
  version: number
  occurredAt: string
}

const CURSOR_PREFIX = 'cursor-'
const CURSOR_SEQUENCE_WIDTH = 8

export function encodeCursor(sequence: number | string | bigint): string {
  return `${CURSOR_PREFIX}${String(sequence).padStart(CURSOR_SEQUENCE_WIDTH, '0')}`
}

/** Decodes a cursor to its sequence, or null if it is not a cursor this server
 *  issued (caller maps null to a 410 Gone / resync). */
export function decodeCursor(cursor: string): number | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    return null
  }
  const raw = cursor.slice(CURSOR_PREFIX.length)
  if (!/^\d+$/.test(raw)) {
    return null
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

const CLOUD_EVENT_SOURCE = 'urn:pie:control-plane'

/**
 * Builds a CloudEvents envelope for any resource change. The org is its own
 * stream (piesequence monotonic per org), so the same outbox → Worker → Realtime
 * path carries organization, artifact, or any future resource with no new plumbing.
 */
export function buildResourceChangeCloudEvent(input: {
  organizationId: string
  eventId: string
  resourceType: ResourceChangeResourceType
  resourceId: string
  changeKind: ResourceChangeKind
  version: number
  occurredAt: string
  traceparent?: string
}): ResourceChangeCloudEvent {
  return {
    specversion: '1.0',
    id: input.eventId,
    source: CLOUD_EVENT_SOURCE,
    type: `ai.pielab.${input.resourceType}.${input.changeKind}.v1`,
    subject: `${input.resourceType}/${input.resourceId}`,
    time: input.occurredAt,
    datacontenttype: 'application/json',
    pieorgid: input.organizationId,
    piestream: input.organizationId,
    ...(input.traceparent ? { traceparent: input.traceparent } : {}),
    data: {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      changeKind: input.changeKind,
      version: input.version
    }
  }
}

export function buildOrganizationUpdatedCloudEvent(input: {
  organizationId: string
  eventId: string
  version: number
  occurredAt: string
  traceparent?: string
}): ResourceChangeCloudEvent {
  return buildResourceChangeCloudEvent({
    organizationId: input.organizationId,
    eventId: input.eventId,
    resourceType: 'organization',
    resourceId: input.organizationId,
    changeKind: 'updated',
    version: input.version,
    occurredAt: input.occurredAt,
    traceparent: input.traceparent
  })
}

/** Parses a stored outbox payload into the change facts, or null if it is not a
 *  recognizable resource-change envelope (a poison row → retry/park). */
export function parseResourceChangeCloudEvent(payload: unknown): ResourceChangeData | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const envelope = payload as Partial<ResourceChangeCloudEvent>
  const data = envelope.data as Partial<ResourceChangeData> | undefined
  if (
    typeof envelope.id !== 'string' ||
    typeof envelope.time !== 'string' ||
    !data ||
    typeof data.resourceType !== 'string' ||
    typeof data.resourceId !== 'string' ||
    typeof data.changeKind !== 'string' ||
    typeof data.version !== 'number'
  ) {
    return null
  }
  return {
    eventId: envelope.id,
    resourceType: data.resourceType as ResourceChangeResourceType,
    resourceId: data.resourceId,
    changeKind: data.changeKind as ResourceChangeKind,
    version: data.version,
    occurredAt: envelope.time
  }
}

export function buildResourceChangedMessage(
  organizationId: string,
  change: ResourceChangeData,
  cursor: string
): ResourceChangedMessage {
  return {
    type: 'resource.changed',
    schemaVersion: 1,
    eventId: change.eventId,
    cursor,
    organizationId,
    resourceType: change.resourceType,
    resourceId: change.resourceId,
    changeKind: change.changeKind,
    version: change.version,
    occurredAt: change.occurredAt
  }
}
