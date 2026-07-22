import { randomUUID } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeResourceType
} from './resource-change-event'

// Shared outbox + audit writes for the meetings vertical (meetings / participants / recordings /
// transcripts / minutes). Each store mutates in its own tenant tx and calls these to ride the existing
// outbox → Worker → gateway invalidation path and append the audit trail that carries the R7 exit
// conditions (a scoped meeting's result is preserved; recording consent + AI-minutes review are
// audited) — factored out because the five resources share it verbatim (mirrors
// automation-resource-events / governance-resource-events).

export type MeetingResourceType = Extract<
  ResourceChangeResourceType,
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
>

export async function emitMeetingResourceChange(
  trx: Transaction<Database>,
  organizationId: string,
  resourceType: MeetingResourceType,
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

export async function auditMeetingEvent(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string | null,
  action: string,
  targetType: MeetingResourceType,
  targetId: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorUserId,
      action,
      target_type: targetType,
      target_id: targetId
    })
    .execute()
}
