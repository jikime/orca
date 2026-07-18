import { randomUUID } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeResourceType
} from './resource-change-event'

// Shared outbox + audit writes for the qa vertical (deliverables / test_cases / defects). Each qa
// store mutates in its own tenant tx and calls these to ride the existing outbox → Worker → gateway
// invalidation path and to append an audit trail — mirroring the per-store emit/audit in
// change-request-store and requirement-store, factored out because three resources share it verbatim.

export type QaResourceType = Extract<
  ResourceChangeResourceType,
  'deliverable' | 'test_case' | 'defect'
>

export async function emitQaResourceChange(
  trx: Transaction<Database>,
  organizationId: string,
  resourceType: QaResourceType,
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

export async function auditQaEvent(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  action: string,
  targetType: QaResourceType,
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
