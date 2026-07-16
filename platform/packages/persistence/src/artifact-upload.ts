import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import type { MutationClock } from './organization-mutation'
import { buildResourceChangeCloudEvent, traceIdFromTraceparent } from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

// artifact.v1 shape.
export type ArtifactResource = {
  id: string
  organizationId: string
  projectId: string
  workItemId: string | null
  name: string
  classification: string
  visibility: string
  status: string
  revision: number
  object: { objectId: string; sha256: string; sizeBytes: number } | null
  version: number
  createdAt: string
}

export class ArtifactUploadSessionNotFoundError extends Error {
  constructor(uploadSessionId: string) {
    super(`artifact upload session ${uploadSessionId} not found or already finalized`)
    this.name = 'ArtifactUploadSessionNotFoundError'
  }
}

function artifactResource(row: {
  id: string
  organization_id: string
  project_id: string
  work_item_id: string | null
  name: string
  classification: string
  visibility: string
  status: string
  current_revision: number
  version: string
  created_at: Date
  object?: { objectId: string; sha256: string; sizeBytes: number } | null
}): ArtifactResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    name: row.name,
    classification: row.classification,
    visibility: row.visibility,
    status: row.status,
    // The contract requires revision >= 1; a pending artifact is on its first.
    revision: row.current_revision > 0 ? row.current_revision : 1,
    object: row.object ?? null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString()
  }
}

// ── Idempotency (operations.idempotency_records, doc 23 §멱등성) ──────────────

export type IdempotencyReservation =
  | { outcome: 'reserved' }
  | { outcome: 'replay'; responseRef: string | null }
  | { outcome: 'conflict' }
  | { outcome: 'in-progress' }

export type IdempotencyScope = {
  organizationId: string
  principalId: string
  method: string
  route: string
  key: string
}

export async function reserveIdempotencyKey(
  db: Kysely<Database>,
  scope: IdempotencyScope & { payloadHash: string }
): Promise<IdempotencyReservation> {
  return withTenantTransaction(db, scope.organizationId, async (trx) => {
    const inserted = await trx
      .insertInto('operations.idempotency_records')
      .values({
        organization_id: scope.organizationId,
        principal_id: scope.principalId,
        request_method: scope.method,
        request_route: scope.route,
        idempotency_key: scope.key,
        payload_hash: scope.payloadHash,
        status: 'in_progress'
      })
      .onConflict((oc) =>
        oc
          .columns([
            'principal_id',
            'organization_id',
            'request_method',
            'request_route',
            'idempotency_key'
          ])
          .doNothing()
      )
      .returning('id')
      .executeTakeFirst()
    if (inserted) {
      return { outcome: 'reserved' }
    }
    const existing = await trx
      .selectFrom('operations.idempotency_records')
      .select(['payload_hash', 'status', 'response_ref'])
      .where('organization_id', '=', scope.organizationId)
      .where('principal_id', '=', scope.principalId)
      .where('request_method', '=', scope.method)
      .where('request_route', '=', scope.route)
      .where('idempotency_key', '=', scope.key)
      .executeTakeFirst()
    if (!existing) {
      return { outcome: 'reserved' }
    }
    if (existing.payload_hash !== scope.payloadHash) {
      return { outcome: 'conflict' }
    }
    if (existing.status === 'completed') {
      return { outcome: 'replay', responseRef: existing.response_ref }
    }
    return { outcome: 'in-progress' }
  })
}

export async function completeIdempotencyKey(
  db: Kysely<Database>,
  scope: IdempotencyScope & { responseRef: string }
): Promise<void> {
  await withTenantTransaction(db, scope.organizationId, async (trx) => {
    await trx
      .updateTable('operations.idempotency_records')
      .set({ status: 'completed', response_ref: scope.responseRef, updated_at: sql`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('principal_id', '=', scope.principalId)
      .where('request_method', '=', scope.method)
      .where('request_route', '=', scope.route)
      .where('idempotency_key', '=', scope.key)
      .execute()
  })
}

// ── Intent + finalize ─────────────────────────────────────────────────────────

export type CreateArtifactUploadIntentInput = {
  organizationId: string
  uploadSessionId: string
  artifactId: string
  objectId: string
  storageKey: string
  projectId: string
  workItemId: string | null
  name: string
  contentType: string
  sizeBytes: number
  sha256: string
  classification: string
  visibility: string
  method: 'single' | 'multipart'
  expiresAt: string
}

/** Creates the pending artifact + staging object + upload session in ONE tenant
 *  transaction. Returns the pending artifact resource. */
export async function createArtifactUploadIntent(
  db: Kysely<Database>,
  input: CreateArtifactUploadIntentInput
): Promise<{ uploadSessionId: string; artifact: ArtifactResource }> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    await trx
      .insertInto('agent.objects')
      .values({
        id: input.objectId,
        organization_id: input.organizationId,
        storage_key: input.storageKey,
        sha256: input.sha256,
        size_bytes: input.sizeBytes,
        content_type: input.contentType,
        classification: input.classification,
        status: 'staging'
      })
      .execute()

    const created = await trx
      .insertInto('agent.artifacts')
      .values({
        id: input.artifactId,
        organization_id: input.organizationId,
        project_id: input.projectId,
        work_item_id: input.workItemId,
        name: input.name,
        classification: input.classification,
        visibility: input.visibility,
        status: 'pending_upload',
        current_revision: 0
      })
      .returning(['created_at', 'version'])
      .executeTakeFirstOrThrow()

    await trx
      .insertInto('operations.artifact_upload_sessions')
      .values({
        id: input.uploadSessionId,
        organization_id: input.organizationId,
        artifact_id: input.artifactId,
        object_id: input.objectId,
        storage_key: input.storageKey,
        sha256: input.sha256,
        size_bytes: input.sizeBytes,
        content_type: input.contentType,
        method: input.method,
        status: 'pending',
        expires_at: input.expiresAt
      })
      .execute()

    return {
      uploadSessionId: input.uploadSessionId,
      artifact: artifactResource({
        id: input.artifactId,
        organization_id: input.organizationId,
        project_id: input.projectId,
        work_item_id: input.workItemId,
        name: input.name,
        classification: input.classification,
        visibility: input.visibility,
        status: 'pending_upload',
        current_revision: 0,
        version: String(created.version),
        created_at: created.created_at,
        // The staging object reference so the client knows what to finalize.
        object: { objectId: input.objectId, sha256: input.sha256, sizeBytes: input.sizeBytes }
      })
    }
  })
}

export type FinalizeArtifactUploadInput = {
  organizationId: string
  uploadSessionId: string
  actorId?: string
  requestId?: string
  traceparent?: string
}

/**
 * Finalizes an upload in ONE tenant transaction (doc 30 :306-323): marks the
 * object available, writes the immutable artifact revision, flips the artifact to
 * available (version bump), and writes the audit + outbox events. The outbox event
 * is a resource-change for the artifact, so the existing Worker → Realtime path
 * delivers artifact.created with no new plumbing.
 */
export async function finalizeArtifactUpload(
  db: Kysely<Database>,
  clock: MutationClock,
  input: FinalizeArtifactUploadInput
): Promise<ArtifactResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await trx
      .selectFrom('operations.artifact_upload_sessions')
      .selectAll()
      .where('id', '=', input.uploadSessionId)
      .where('status', '=', 'pending')
      .forUpdate()
      .executeTakeFirst()
    if (!session) {
      throw new ArtifactUploadSessionNotFoundError(input.uploadSessionId)
    }

    await trx
      .updateTable('agent.objects')
      .set({ status: 'available' })
      .where('id', '=', session.object_id)
      .execute()

    await trx
      .insertInto('agent.artifact_revisions')
      .values({
        id: clock.newId(),
        organization_id: input.organizationId,
        artifact_id: session.artifact_id,
        revision: 1,
        object_id: session.object_id,
        sha256: session.sha256,
        size_bytes: session.size_bytes,
        status: 'available'
      })
      .execute()

    const artifact = await trx
      .selectFrom('agent.artifacts')
      .selectAll()
      .where('id', '=', session.artifact_id)
      .forUpdate()
      .executeTakeFirstOrThrow()
    const newVersion = Number(artifact.version) + 1
    const occurredAt = new Date(clock.now()).toISOString()

    await trx
      .updateTable('agent.artifacts')
      .set({
        status: 'available',
        current_revision: 1,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', session.artifact_id)
      .execute()

    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorId ?? null,
        action: 'artifact.finalized',
        target_type: 'artifact',
        target_id: session.artifact_id,
        after_digest: session.sha256,
        request_id: input.requestId ?? null,
        trace_id: traceIdFromTraceparent(input.traceparent)
      })
      .execute()

    const outboxId = clock.newId()
    await trx
      .insertInto('operations.outbox_events')
      .values({
        id: outboxId,
        organization_id: input.organizationId,
        aggregate_type: 'artifact',
        aggregate_id: session.artifact_id,
        aggregate_version: newVersion,
        event_type: 'ai.pielab.artifact.created.v1',
        event_schema_version: 1,
        payload: JSON.stringify(
          buildResourceChangeCloudEvent({
            organizationId: input.organizationId,
            eventId: outboxId,
            resourceType: 'artifact',
            resourceId: session.artifact_id,
            changeKind: 'created',
            version: newVersion,
            occurredAt,
            traceparent: input.traceparent
          })
        ),
        occurred_at: occurredAt,
        available_at: occurredAt
      })
      .execute()

    await trx
      .updateTable('operations.artifact_upload_sessions')
      .set({ status: 'finalized' })
      .where('id', '=', input.uploadSessionId)
      .execute()

    return artifactResource({
      ...artifact,
      status: 'available',
      current_revision: 1,
      version: String(newVersion),
      object: {
        objectId: session.object_id,
        sha256: session.sha256,
        sizeBytes: Number(session.size_bytes)
      }
    })
  })
}

export type ArtifactUploadSessionView = {
  uploadSessionId: string
  status: string
  objectId: string
  storageKey: string
  contentType: string
  sha256: string
  sizeBytes: number
  artifact: ArtifactResource
}

/** Reloads a session so the API can verify the object (HEAD), re-presign on an
 *  idempotent replay, or return the finalized artifact. */
export async function getArtifactUploadSession(
  db: Kysely<Database>,
  organizationId: string,
  uploadSessionId: string
): Promise<ArtifactUploadSessionView | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const session = await trx
      .selectFrom('operations.artifact_upload_sessions')
      .selectAll()
      .where('id', '=', uploadSessionId)
      .executeTakeFirst()
    if (!session) {
      return null
    }
    const artifact = await trx
      .selectFrom('agent.artifacts')
      .selectAll()
      .where('id', '=', session.artifact_id)
      .executeTakeFirstOrThrow()
    return {
      uploadSessionId,
      status: session.status,
      objectId: session.object_id,
      storageKey: session.storage_key,
      contentType: session.content_type,
      sha256: session.sha256,
      sizeBytes: Number(session.size_bytes),
      artifact: artifactResource({ ...artifact, version: String(artifact.version) })
    }
  })
}
