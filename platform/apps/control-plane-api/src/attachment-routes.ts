import {
  createAttachmentIntent,
  getAttachmentForDownload,
  type PieDatabase
} from '@pie/persistence'
import { createTenantObjectKeyBuilder, type ObjectStorage } from '@pie/object-storage-adapter'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const INTENT_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/attachment-intent-create.v1.schema.json'
const INTENT_SCHEMA_ID = 'https://schemas.pielab.ai/resources/attachment-intent.v1.schema.json'
const DOWNLOAD_SCHEMA_ID = 'https://schemas.pielab.ai/resources/attachment-download.v1.schema.json'
const ATTACHMENT_INTENTS_ROUTE =
  '/v1/organizations/{organizationId}/channels/{channelId}/attachments/intents'
const UPLOAD_EXPIRY_S = 900
const DOWNLOAD_EXPIRY_S = 300
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AttachmentRoutesDeps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  objectStorage: ObjectStorage
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

function validates(registry: ContractSchemaRegistry, schemaId: string, body: unknown): boolean {
  const validate = registry.ajv.getSchema(schemaId)
  return !validate || validate(body) === true
}

function assertResponse(registry: ContractSchemaRegistry, schemaId: string, body: unknown): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${schemaId}`)
  }
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRoutesDeps): void {
  app.post(
    '/v1/organizations/:organizationId/channels/:channelId/attachments/intents',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId } = request.params as {
        organizationId: string
        channelId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(channelId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'message.post'
      )
      if (!authz) return reply
      if (!validates(deps.registry, INTENT_CREATE_SCHEMA_ID, request.body))
        return problem(
          reply,
          request,
          400,
          'VALIDATION_FAILED',
          'invalid attachment intent request'
        )
      const body = request.body as { filename: string; contentType: string; byteSize: number }
      // The key is server-derived; a client-supplied path would already be rejected by
      // additionalProperties:false. Guard the display filename against path/scheme too.
      if (/[/\\]/.test(body.filename) || /^[a-z]+:/i.test(body.filename))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'filename must not contain a path')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: principal.subject,
          method: 'POST',
          route: ATTACHMENT_INTENTS_ROUTE
        },
        request.body
      )
      if (!gate) return reply
      // The key builder is BOUND to this org — cross-tenant keys are impossible.
      const { objectId, storageKey } =
        createTenantObjectKeyBuilder(organizationId).newKey('attachments')
      const result = await createAttachmentIntent(deps.db, {
        organizationId,
        channelId,
        userId: authz.userId ?? organizationId,
        objectId,
        storageKey,
        filename: body.filename,
        contentType: body.contentType,
        byteSize: body.byteSize
      })
      if (!result.ok) {
        await gate.release()
        if (result.reason === 'channel_not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      await gate.complete(result.attachmentId)
      const uploadUrl = await deps.objectStorage.presignPut(storageKey, {
        contentType: body.contentType,
        expiresInSeconds: UPLOAD_EXPIRY_S
      })
      const response = {
        id: result.attachmentId,
        objectId,
        uploadUrl,
        expiresAt: new Date(Date.now() + UPLOAD_EXPIRY_S * 1000).toISOString()
      }
      assertResponse(deps.registry, INTENT_SCHEMA_ID, response)
      void reply
        .code(201)
        .header(
          'location',
          `/v1/organizations/${organizationId}/channels/${channelId}/attachments/${result.attachmentId}`
        )
      return response
    }
  )

  app.get(
    '/v1/organizations/:organizationId/channels/:channelId/attachments/:attachmentId/download',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, attachmentId } = request.params as {
        organizationId: string
        channelId: string
        attachmentId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(attachmentId)
      )
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'message.read'
      )
      if (!authz) return reply
      const result = await getAttachmentForDownload(
        deps.db,
        organizationId,
        attachmentId,
        authz.userId ?? organizationId
      )
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'attachment not found')
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      const url = await deps.objectStorage.presignGet(result.storageKey, {
        expiresInSeconds: DOWNLOAD_EXPIRY_S
      })
      const response = {
        url,
        filename: result.filename,
        contentType: result.contentType,
        expiresAt: new Date(Date.now() + DOWNLOAD_EXPIRY_S * 1000).toISOString()
      }
      assertResponse(deps.registry, DOWNLOAD_SCHEMA_ID, response)
      return response
    }
  )
}
