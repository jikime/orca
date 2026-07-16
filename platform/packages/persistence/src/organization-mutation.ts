import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { buildOrganizationUpdatedCloudEvent } from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

export type MutationClock = {
  now: () => number
  newId: () => string
}

export type UpdateOrganizationDisplayNameInput = {
  organizationId: string
  displayName: string
  // Optimistic concurrency (the domain-layer equivalent of an If-Match ETag);
  // omit to force the update.
  expectedVersion?: number
  actorId?: string
  requestId?: string
  traceId?: string
}

export type UpdateOrganizationDisplayNameResult = {
  organizationId: string
  version: number
  operationId: string
  outboxId: string
}

export class OrganizationNotFoundError extends Error {
  constructor(organizationId: string) {
    super(`organization ${organizationId} not found`)
    this.name = 'OrganizationNotFoundError'
  }
}

export class OrganizationVersionConflictError extends Error {
  readonly currentVersion: number
  constructor(currentVersion: number) {
    super('organization version conflict')
    this.name = 'OrganizationVersionConflictError'
    this.currentVersion = currentVersion
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

/**
 * The authoritative organization mutation. In ONE transaction it bumps the org
 * version, writes the audit event, enqueues the outbox event, and records the
 * operation (doc 30 :306-323). All four rows commit together or not at all —
 * there is no partial state and no side effect before commit.
 */
export async function updateOrganizationDisplayName(
  db: Kysely<Database>,
  clock: MutationClock,
  input: UpdateOrganizationDisplayNameInput
): Promise<UpdateOrganizationDisplayNameResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    // Lock the aggregate row so concurrent mutations to the same org serialize
    // and version/sequence ordering is well defined.
    const current = await trx
      .selectFrom('identity.organizations')
      .select(['version', 'display_name'])
      .where('id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      throw new OrganizationNotFoundError(input.organizationId)
    }
    const currentVersion = Number(current.version)
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      throw new OrganizationVersionConflictError(currentVersion)
    }

    const newVersion = currentVersion + 1
    const occurredAt = new Date(clock.now()).toISOString()

    await trx
      .updateTable('identity.organizations')
      .set({ display_name: input.displayName, version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.organizationId)
      .execute()

    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorId ?? null,
        action: 'organization.display_name.updated',
        target_type: 'organization',
        target_id: input.organizationId,
        before_digest: digest(current.display_name),
        after_digest: digest(input.displayName),
        request_id: input.requestId ?? null,
        trace_id: input.traceId ?? null
      })
      .execute()

    const outboxId = clock.newId()
    const cloudEvent = buildOrganizationUpdatedCloudEvent({
      organizationId: input.organizationId,
      eventId: outboxId,
      version: newVersion,
      occurredAt
    })
    await trx
      .insertInto('operations.outbox_events')
      .values({
        id: outboxId,
        organization_id: input.organizationId,
        aggregate_type: 'organization',
        aggregate_id: input.organizationId,
        aggregate_version: newVersion,
        event_type: cloudEvent.type,
        event_schema_version: 1,
        payload: JSON.stringify(cloudEvent),
        occurred_at: occurredAt,
        available_at: occurredAt
      })
      .execute()

    const operationId = clock.newId()
    await trx
      .insertInto('operations.operations')
      .values({
        id: operationId,
        organization_id: input.organizationId,
        kind: 'organization.update',
        status: 'succeeded',
        result_resource_id: input.organizationId
      })
      .execute()

    return { organizationId: input.organizationId, version: newVersion, operationId, outboxId }
  })
}
