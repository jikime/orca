import { createHash, randomUUID } from 'node:crypto'
import { createTenantObjectKeyBuilder, type ObjectStorage } from '@pie/object-storage-adapter'
import {
  ArtifactUploadSessionNotFoundError,
  completeIdempotencyKey,
  createArtifactUploadIntent,
  finalizeArtifactUpload,
  getArtifactUploadSession,
  reserveIdempotencyKey,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'

const INTENT_REQUEST_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/artifact-upload-intent-request.v1.schema.json'
const FINALIZE_REQUEST_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/artifact-upload-finalize-request.v1.schema.json'
const ARTIFACT_SCHEMA_ID = 'https://schemas.pielab.ai/resources/artifact.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FINALIZE_SUFFIX = ':finalize'
const UPLOAD_INTENT_EXPIRY_MS = 15 * 60 * 1000
const MAX_PART_BYTES = 5 * 1024 * 1024

export type ArtifactRoutesDeps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  objectStorage: ObjectStorage
}

type IntentRequest = {
  projectId: string
  workItemId: string | null
  name: string
  contentType: string
  sizeBytes: number
  sha256: string
  classification: string
  visibility: string
}

type FinalizeRequest = {
  uploadSessionId: string
  object: { objectId: string; sha256: string; sizeBytes: number }
}

function problem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  title: string
): FastifyReply {
  sendProblem(
    reply,
    buildProblemDetails({
      status,
      title,
      code,
      requestId: requestCorrelationId(request),
      instance: request.url
    })
  )
  return reply
}

function idempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && value.length >= 1 && value.length <= 255 ? value : null
}

function validates(registry: ContractSchemaRegistry, schemaId: string, body: unknown): boolean {
  const validate = registry.ajv.getSchema(schemaId)
  return validate ? validate(body) === true : false
}

function assertResponseMatchesContract(
  registry: ContractSchemaRegistry,
  schemaId: string,
  body: unknown
): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${schemaId}`)
  }
}

export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRoutesDeps): void {
  const clock = { now: () => Date.now(), newId: () => randomUUID() }

  app.post('/v1/organizations/:organizationId/artifacts/upload-intents', async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId)) {
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    }
    const key = idempotencyKey(request)
    if (!key) {
      return problem(reply, request, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required')
    }
    // additionalProperties:false rejects a localPath / file: target (invalid fixture).
    if (!validates(deps.registry, INTENT_REQUEST_SCHEMA_ID, request.body)) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid upload intent request')
    }
    const body = request.body as IntentRequest
    // principalId is the org until R3 provides an authenticated subject.
    const scope = {
      organizationId,
      principalId: organizationId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/artifacts/upload-intents',
      key
    }
    const payloadHash = createHash('sha256').update(JSON.stringify(body), 'utf-8').digest('hex')
    const reservation = await reserveIdempotencyKey(deps.db, { ...scope, payloadHash })
    if (reservation.outcome === 'conflict') {
      return problem(
        reply,
        request,
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'key reused with a different payload'
      )
    }
    if (reservation.outcome === 'in-progress') {
      return problem(
        reply,
        request,
        409,
        'IDEMPOTENCY_IN_PROGRESS',
        'a matching request is in progress'
      )
    }
    if (reservation.outcome === 'replay' && reservation.responseRef) {
      const existing = await getArtifactUploadSession(
        deps.db,
        organizationId,
        reservation.responseRef
      )
      if (existing) {
        return replyWithIntent(
          reply,
          deps,
          organizationId,
          existing.uploadSessionId,
          existing.artifact,
          existing.storageKey,
          existing.contentType
        )
      }
    }

    const keyBuilder = createTenantObjectKeyBuilder(organizationId)
    const { objectId, storageKey } = keyBuilder.newKey('artifacts')
    const uploadSessionId = randomUUID()
    const artifactId = randomUUID()
    const expiresAt = new Date(Date.now() + UPLOAD_INTENT_EXPIRY_MS).toISOString()
    const { artifact } = await createArtifactUploadIntent(deps.db, {
      organizationId,
      uploadSessionId,
      artifactId,
      objectId,
      storageKey,
      projectId: body.projectId,
      workItemId: body.workItemId,
      name: body.name,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      classification: body.classification,
      visibility: body.visibility,
      method: 'single',
      expiresAt
    })
    await completeIdempotencyKey(deps.db, { ...scope, responseRef: uploadSessionId })
    return replyWithIntent(
      reply,
      deps,
      organizationId,
      uploadSessionId,
      artifact,
      storageKey,
      body.contentType,
      expiresAt
    )
  })

  app.post(
    '/v1/organizations/:organizationId/artifacts/uploads/:sessionRef',
    async (request, reply) => {
      const { organizationId, sessionRef } = request.params as {
        organizationId: string
        sessionRef: string
      }
      if (!UUID_PATTERN.test(organizationId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
      }
      // The contract path is `.../uploads/{uploadSessionId}:finalize`.
      if (!sessionRef.endsWith(FINALIZE_SUFFIX)) {
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown upload action')
      }
      const uploadSessionId = sessionRef.slice(0, -FINALIZE_SUFFIX.length)
      if (!UUID_PATTERN.test(uploadSessionId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid uploadSessionId')
      }
      if (!idempotencyKey(request)) {
        return problem(
          reply,
          request,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Idempotency-Key is required'
        )
      }
      if (!validates(deps.registry, FINALIZE_REQUEST_SCHEMA_ID, request.body)) {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid finalize request')
      }
      const body = request.body as FinalizeRequest

      const session = await getArtifactUploadSession(deps.db, organizationId, uploadSessionId)
      if (!session) {
        return problem(reply, request, 404, 'NOT_FOUND', 'upload session not found')
      }
      // Idempotent: a finalized session returns its artifact unchanged.
      if (session.status === 'finalized') {
        assertResponseMatchesContract(deps.registry, ARTIFACT_SCHEMA_ID, session.artifact)
        void reply.header('etag', `"artifact-${session.artifact.version}"`)
        return session.artifact
      }
      if (
        body.object.objectId !== session.objectId ||
        body.object.sha256 !== session.sha256 ||
        body.object.sizeBytes !== session.sizeBytes
      ) {
        return problem(
          reply,
          request,
          422,
          'OBJECT_MISMATCH',
          'finalize object does not match the intent'
        )
      }
      const head = await deps.objectStorage.head(session.storageKey)
      if (!head.exists) {
        return problem(reply, request, 409, 'OBJECT_NOT_UPLOADED', 'the object was not uploaded')
      }
      if (head.sizeBytes !== session.sizeBytes) {
        return problem(
          reply,
          request,
          422,
          'OBJECT_SIZE_MISMATCH',
          'uploaded size does not match the intent'
        )
      }

      try {
        const artifact = await finalizeArtifactUpload(deps.db, clock, {
          organizationId,
          uploadSessionId,
          requestId: request.traceId
        })
        assertResponseMatchesContract(deps.registry, ARTIFACT_SCHEMA_ID, artifact)
        void reply.header('etag', `"artifact-${artifact.version}"`)
        return artifact
      } catch (error) {
        if (error instanceof ArtifactUploadSessionNotFoundError) {
          return problem(reply, request, 404, 'NOT_FOUND', 'upload session not found')
        }
        throw error
      }
    }
  )
}

async function replyWithIntent(
  reply: FastifyReply,
  deps: ArtifactRoutesDeps,
  organizationId: string,
  uploadSessionId: string,
  artifact: unknown,
  storageKey: string,
  contentType: string,
  expiresAt: string = new Date(Date.now() + UPLOAD_INTENT_EXPIRY_MS).toISOString()
): Promise<FastifyReply> {
  const uploadEndpoint = await deps.objectStorage.presignPut(storageKey, {
    contentType,
    expiresInSeconds: 900
  })
  // The intent response is server-constructed; we do not runtime-validate it
  // against the contract because uploadEndpoint requires https:// (a production
  // TLS concern) while dev object storage is plain http.
  return reply
    .code(201)
    .header(
      'location',
      `/v1/organizations/${organizationId}/artifacts/uploads/${uploadSessionId}:finalize`
    )
    .send({
      uploadSessionId,
      artifact,
      method: 'single',
      uploadEndpoint,
      expiresAt,
      maxPartBytes: MAX_PART_BYTES
    })
}
