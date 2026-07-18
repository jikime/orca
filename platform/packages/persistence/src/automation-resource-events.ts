import { randomUUID } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeResourceType
} from './resource-change-event'

// Shared outbox + audit writes for the automation vertical (runbooks / runbook_executions /
// work_queue_items). Each store mutates in its own tenant tx and calls these to ride the existing
// outbox → Worker → gateway invalidation path and append the audit trail that carries the R7 exit
// condition (target/approval/result/rollback are audited) — factored out because the three
// resources share it verbatim (mirrors governance-resource-events / qa-resource-events).

export type AutomationResourceType = Extract<
  ResourceChangeResourceType,
  'runbook' | 'runbook_execution' | 'work_queue_item'
>

export async function emitAutomationResourceChange(
  trx: Transaction<Database>,
  organizationId: string,
  resourceType: AutomationResourceType,
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

export async function auditAutomationEvent(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  action: string,
  targetType: AutomationResourceType,
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
