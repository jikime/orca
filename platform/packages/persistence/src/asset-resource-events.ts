import { randomUUID } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeKind,
  type ResourceChangeResourceType
} from './resource-change-event'

// Shared outbox + audit writes for the asset vertical (assets / asset_links / asset_events). Each asset
// store mutates in its own tenant tx and calls these to ride the existing outbox → Worker → gateway
// invalidation path and append an audit trail — factored out because the three resources share it
// verbatim (mirrors governance-resource-events).

export type AssetResourceType = Extract<
  ResourceChangeResourceType,
  'asset' | 'asset_link' | 'asset_event'
>

export async function emitAssetResourceChange(
  trx: Transaction<Database>,
  organizationId: string,
  resourceType: AssetResourceType,
  resourceId: string,
  version: number,
  changeKind: Extract<ResourceChangeKind, 'created' | 'updated' | 'deleted'>
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

export async function auditAssetEvent(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  action: string,
  targetType: AssetResourceType,
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
