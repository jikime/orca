import {
  addChannelMember,
  addReaction,
  authorizeSubjectForOrg,
  convertMessageToWorkItem,
  createChannel,
  createDm,
  createGroupDm,
  deleteMessage,
  editMessage,
  fireEphemeralNotification,
  getChannelForMember,
  getChannelKind,
  getMessageWithReactions,
  getPendingAttachment,
  getReadCursor,
  getWorkItem,
  isOrgMember,
  listChannelMessages,
  listChannels,
  listPins,
  listWorkItemLinksForMessage,
  markChannelRead,
  MAX_PINS_PER_CHANNEL,
  pinMessage,
  postMessage,
  removeReaction,
  unpinMessage,
  type ChannelKind,
  type ChannelResource,
  type ChannelVisibility,
  type MessageResource,
  type PieDatabase,
  type ReadCursorResource,
  type WorkItemPriority,
  type WorkItemResource
} from '@pie/persistence'
import type { ObjectStorage } from '@pie/object-storage-adapter'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import type { RealtimeGateway } from './realtime-gateway'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const CHANNEL_SCHEMA_ID = 'https://schemas.pielab.ai/resources/channel.v1.schema.json'
const CHANNEL_CREATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/channel-create.v1.schema.json'
const DM_CREATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/dm-create.v1.schema.json'
const GROUP_DM_CREATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/group-dm-create.v1.schema.json'
const MESSAGE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/message.v1.schema.json'
const MESSAGE_CREATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/message-create.v1.schema.json'
const MESSAGE_EDIT_SCHEMA_ID = 'https://schemas.pielab.ai/resources/message-edit.v1.schema.json'
const READ_CURSOR_SCHEMA_ID = 'https://schemas.pielab.ai/resources/read-cursor.v1.schema.json'
const PINNED_MESSAGES_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/pinned-messages.v1.schema.json'
const WORK_ITEM_SCHEMA_ID = 'https://schemas.pielab.ai/resources/work-item.v1.schema.json'
const MESSAGE_CONVERSION_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/message-work-item-conversion.v1.schema.json'
const MESSAGE_WORK_ITEMS_ROUTE =
  '/v1/organizations/{organizationId}/channels/{channelId}/messages/{messageId}/work-items'
const CHANNELS_ROUTE = '/v1/organizations/{organizationId}/channels'
const DMS_ROUTE = '/v1/organizations/{organizationId}/dms'
const GROUP_DMS_ROUTE = '/v1/organizations/{organizationId}/group-dms'
const CHANNEL_MESSAGES_ROUTE = '/v1/organizations/{organizationId}/channels/{channelId}/messages'
const CHANNEL_REACTIONS_ROUTE =
  '/v1/organizations/{organizationId}/channels/{channelId}/messages/{messageId}/reactions'
const CHANNEL_READ_ROUTE = '/v1/organizations/{organizationId}/channels/{channelId}/read'
const EMOJI_PATTERN = /^.{1,32}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The message ETag / If-Match carrier for edit OCC — same shape as the work-item PATCH.
function messageEtag(version: number): string {
  return `"message-${version}"`
}

function ifMatchMessageVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"message-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

export type ChannelRoutesDeps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  // Present when object storage is configured; required to HEAD-verify attachments a
  // post links. A post WITHOUT attachments needs no object storage.
  objectStorage?: ObjectStorage
  // The in-process realtime gateway; its per-node present set resolves @here mentions.
  gateway?: RealtimeGateway
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

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRoutesDeps): void {
  // Per-(user,channel) typing coalesce: at most one ephemeral typing ping per second
  // so a client can't flood the presence path (data-over-presence). In-memory for the
  // app instance; a bounded/LRU eviction is a later refinement.
  const typingLastFired = new Map<string, number>()
  const TYPING_COALESCE_MS = 1000

  app.get('/v1/organizations/:organizationId/channels', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'channel.read'
    )
    if (!authz) return reply
    const { kind } = request.query as { kind?: string }
    if (kind !== undefined && kind !== 'channel' && kind !== 'dm')
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid kind')
    const items = authz.userId
      ? await listChannels(
          deps.db,
          organizationId,
          authz.userId,
          kind ? { kind: kind as ChannelKind } : {}
        )
      : []
    for (const item of items) assertResponse(deps.registry, CHANNEL_SCHEMA_ID, item)
    return { items, nextCursor: null }
  })

  app.post('/v1/organizations/:organizationId/channels', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'channel.create'
    )
    if (!authz) return reply
    if (!validates(deps.registry, CHANNEL_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid channel create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: CHANNELS_ROUTE },
      request.body
    )
    if (!gate) return reply
    const respondChannel = (channel: ChannelResource): ChannelResource => {
      assertResponse(deps.registry, CHANNEL_SCHEMA_ID, channel)
      void reply
        .code(201)
        .header('location', `/v1/organizations/${organizationId}/channels/${channel.id}`)
      return channel
    }
    if (gate.priorResourceId) {
      const existing = await getChannelForMember(
        deps.db,
        organizationId,
        gate.priorResourceId,
        authz.userId ?? organizationId
      )
      if (existing.ok) return respondChannel(existing.channel)
    }
    const body = request.body as { name: string; visibility?: ChannelVisibility }
    const channel = await createChannel(deps.db, {
      organizationId,
      actorUserId: authz.userId ?? organizationId,
      name: body.name,
      visibility: body.visibility
    })
    await gate.complete(channel.id)
    return respondChannel(channel)
  })

  app.get('/v1/organizations/:organizationId/channels/:channelId', async (request, reply) => {
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
      'channel.read'
    )
    if (!authz) return reply
    const result = await getChannelForMember(
      deps.db,
      organizationId,
      channelId,
      authz.userId ?? organizationId
    )
    if (!result.ok) {
      if (result.reason === 'not_found')
        return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
      return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
    }
    assertResponse(deps.registry, CHANNEL_SCHEMA_ID, result.channel)
    return result.channel
  })

  // Find-or-create the DM between the caller and one other org member (idempotent via
  // dm_key). 201 when created, 200 when it already existed. A DM is a channel — every
  // messaging feature works in it with no DM-specific code.
  app.post('/v1/organizations/:organizationId/dms', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'channel.create'
    )
    if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
    if (!validates(deps.registry, DM_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid dm create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: DMS_ROUTE },
      request.body
    )
    if (!gate) return reply
    const respondDm = (channel: ChannelResource, created: boolean): ChannelResource => {
      assertResponse(deps.registry, CHANNEL_SCHEMA_ID, channel)
      void reply
        .code(created ? 201 : 200)
        .header('location', `/v1/organizations/${organizationId}/channels/${channel.id}`)
      return channel
    }
    if (gate.priorResourceId) {
      const existing = await getChannelForMember(
        deps.db,
        organizationId,
        gate.priorResourceId,
        authz.userId
      )
      if (existing.ok) return respondDm(existing.channel, false)
    }
    const { otherUserId } = request.body as { otherUserId: string }
    const result = await createDm(deps.db, {
      organizationId,
      actorUserId: authz.userId,
      otherUserId
    })
    if ('error' in result) {
      await gate.release()
      return problem(
        reply,
        request,
        422,
        'INVALID_DM_TARGET',
        'the other user is not a member of this org'
      )
    }
    await gate.complete(result.channel.id)
    return respondDm(result.channel, result.created)
  })

  // Find-or-create an N-party group DM among the caller and the listed org members
  // (idempotent via dm_key over the full participant set). A group DM is a channel with
  // kind='dm', so its roster is fixed at creation — adding someone means a new group DM
  // with a new dm_key (see the member route's DM_ROSTER_FIXED guard). The caller is
  // implicit and need not be listed.
  app.post('/v1/organizations/:organizationId/group-dms', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'channel.create'
    )
    if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
    if (!validates(deps.registry, GROUP_DM_CREATE_SCHEMA_ID, request.body))
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid group dm create request')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: GROUP_DMS_ROUTE },
      request.body
    )
    if (!gate) return reply
    const respondDm = (channel: ChannelResource, created: boolean): ChannelResource => {
      assertResponse(deps.registry, CHANNEL_SCHEMA_ID, channel)
      void reply
        .code(created ? 201 : 200)
        .header('location', `/v1/organizations/${organizationId}/channels/${channel.id}`)
      return channel
    }
    if (gate.priorResourceId) {
      const existing = await getChannelForMember(
        deps.db,
        organizationId,
        gate.priorResourceId,
        authz.userId
      )
      if (existing.ok) return respondDm(existing.channel, false)
    }
    const { participantUserIds } = request.body as { participantUserIds: string[] }
    const result = await createGroupDm(deps.db, {
      organizationId,
      actorUserId: authz.userId,
      participantUserIds
    })
    if ('error' in result) {
      await gate.release()
      // Roster-shape violations are request-validation (400); a non-org participant is a
      // semantic conflict with org membership (422), matching the 1:1 DM convention.
      if (result.error === 'too_few_participants')
        return problem(
          reply,
          request,
          400,
          'VALIDATION_FAILED',
          'a group DM needs at least 3 distinct participants (use /dms for a 1:1)'
        )
      if (result.error === 'too_many_participants')
        return problem(
          reply,
          request,
          400,
          'VALIDATION_FAILED',
          'a group DM exceeds the participant limit'
        )
      return problem(
        reply,
        request,
        422,
        'INVALID_DM_TARGET',
        'a participant is not a member of this org'
      )
    }
    await gate.complete(result.channel.id)
    return respondDm(result.channel, result.created)
  })

  // Add an org member to a NORMAL channel (channel.manage). Denied on a DM (409) — a
  // DM's roster is fixed. Idempotent (204); no key reserved.
  app.post(
    '/v1/organizations/:organizationId/channels/:channelId/members',
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
        'channel.manage'
      )
      if (!authz) return reply
      const body = request.body as { userId?: string }
      if (typeof body?.userId !== 'string' || !UUID_PATTERN.test(body.userId))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'userId is required')
      const kind = await getChannelKind(deps.db, organizationId, channelId)
      if (kind === null) return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
      // Moderation deny-list: channel.manage-type ops are rejected on a DM regardless
      // of role. This covers group DMs too (also kind='dm') — their roster is fixed at
      // creation, so adding someone means creating a new group DM with a new dm_key.
      if (kind === 'dm')
        return problem(
          reply,
          request,
          409,
          'DM_ROSTER_FIXED',
          'a direct message roster cannot be changed'
        )
      if (!(await isOrgMember(deps.db, organizationId, body.userId)))
        return problem(reply, request, 422, 'NOT_ORG_MEMBER', 'user is not a member of this org')
      await addChannelMember(deps.db, { organizationId, channelId, userId: body.userId })
      void reply.code(204).send()
      return reply
    }
  )

  app.post(
    '/v1/organizations/:organizationId/channels/:channelId/messages',
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
      if (!validates(deps.registry, MESSAGE_CREATE_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid message create request')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: principal.subject,
          method: 'POST',
          route: CHANNEL_MESSAGES_ROUTE
        },
        request.body
      )
      if (!gate) return reply
      const respondMessage = (message: MessageResource): MessageResource => {
        assertResponse(deps.registry, MESSAGE_SCHEMA_ID, message)
        void reply
          .code(201)
          .header(
            'location',
            `/v1/organizations/${organizationId}/channels/${channelId}/messages/${message.id}`
          )
        return message
      }
      const userId = authz.userId ?? organizationId
      if (gate.priorResourceId) {
        const existing = await getMessageWithReactions(
          deps.db,
          organizationId,
          gate.priorResourceId,
          userId
        )
        if (existing) return respondMessage(existing)
      }
      const body = request.body as {
        body: string
        visibility?: ChannelVisibility
        threadRootMessageId?: string
        mentions?: string[]
        mentionChannel?: boolean
        mentionHere?: boolean
        attachmentIds?: string[]
      }
      // attach-at-post: HEAD-verify each referenced attachment (exists + declared size)
      // in THIS channel before it is linked in the message tx. The object storage HEAD
      // stays at the route (S3); the store only links the verified ids.
      if (body.attachmentIds && body.attachmentIds.length > 0) {
        if (!deps.objectStorage) {
          await gate.release()
          return problem(
            reply,
            request,
            503,
            'OBJECT_STORAGE_UNAVAILABLE',
            'attachments unavailable'
          )
        }
        for (const attachmentId of body.attachmentIds) {
          const pending = await getPendingAttachment(deps.db, organizationId, attachmentId)
          if (!pending || pending.channelId !== channelId || pending.status !== 'pending') {
            await gate.release()
            return problem(
              reply,
              request,
              422,
              'INVALID_ATTACHMENT',
              'attachment is not a pending upload in this channel'
            )
          }
          const head = await deps.objectStorage.head(pending.storageKey)
          if (!head.exists || head.sizeBytes !== pending.byteSize) {
            await gate.release()
            return problem(
              reply,
              request,
              422,
              'INVALID_ATTACHMENT',
              'attachment object missing or size mismatch'
            )
          }
        }
      }
      // @here reads the in-process gateway's per-node present set (best-effort; see
      // presentUserIds). Only computed when requested and a gateway is registered.
      const presentUserIds =
        body.mentionHere && deps.gateway ? deps.gateway.presentUserIds(organizationId) : undefined
      const result = await postMessage(deps.db, {
        organizationId,
        channelId,
        authorUserId: userId,
        body: body.body,
        visibility: body.visibility,
        logger: request.log,
        ...(body.threadRootMessageId ? { threadRootMessageId: body.threadRootMessageId } : {}),
        ...(body.mentions ? { mentions: body.mentions } : {}),
        ...(body.mentionChannel ? { mentionChannel: true } : {}),
        ...(body.mentionHere ? { mentionHere: true } : {}),
        ...(presentUserIds ? { presentUserIds } : {}),
        ...(body.attachmentIds ? { attachmentIds: body.attachmentIds } : {})
      })
      if (!result.ok) {
        await gate.release()
        if (result.reason === 'channel_not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
        if (result.reason === 'invalid_thread_root')
          return problem(
            reply,
            request,
            422,
            'INVALID_THREAD_ROOT',
            'thread root is not a root message in this channel'
          )
        if (result.reason === 'invalid_attachment')
          return problem(reply, request, 422, 'INVALID_ATTACHMENT', 'invalid attachment reference')
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      await gate.complete(result.message.id)
      return respondMessage(result.message)
    }
  )

  app.get(
    '/v1/organizations/:organizationId/channels/:channelId/messages',
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
        'message.read'
      )
      if (!authz) return reply
      const query = request.query as { cursor?: string; limit?: string; threadRoot?: string }
      if (query.cursor !== undefined && !UUID_PATTERN.test(query.cursor))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid cursor')
      if (query.threadRoot !== undefined && !UUID_PATTERN.test(query.threadRoot))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid threadRoot')
      const result = await listChannelMessages(
        deps.db,
        organizationId,
        channelId,
        authz.userId ?? organizationId,
        {
          ...(query.limit ? { limit: Number(query.limit) } : {}),
          ...(query.cursor ? { afterMessageId: query.cursor } : {}),
          ...(query.threadRoot ? { threadRootMessageId: query.threadRoot } : {})
        }
      )
      if (!result.ok) {
        if (result.reason === 'channel_not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      for (const message of result.messages)
        assertResponse(deps.registry, MESSAGE_SCHEMA_ID, message)
      return { items: result.messages, nextCursor: result.nextCursor }
    }
  )

  // Edit a message (doc 33 §1). Auth message.post; the store enforces author-only + OCC
  // (expectedVersion). Returns the updated message so the client re-renders with the new
  // body + "(edited)" marker. reasons → HTTP: forbidden 403, version_conflict 409, gone 409.
  app.patch(
    '/v1/organizations/:organizationId/channels/:channelId/messages/:messageId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, messageId } = request.params as {
        organizationId: string
        channelId: string
        messageId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(messageId)
      )
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
      // OCC via If-Match (message ETag), mirroring the work-item PATCH convention.
      const expectedVersion = ifMatchMessageVersion(request)
      if (expectedVersion === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      if (!validates(deps.registry, MESSAGE_EDIT_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid message edit request')
      const body = request.body as { body: string }
      const userId = authz.userId ?? organizationId
      const result = await editMessage(deps.db, {
        organizationId,
        channelId,
        messageId,
        actorUserId: userId,
        newBody: body.body,
        expectedVersion
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'message not found')
        if (result.reason === 'forbidden')
          return problem(reply, request, 403, 'FORBIDDEN', 'only the author may edit this message')
        if (result.reason === 'gone')
          return problem(reply, request, 409, 'MESSAGE_DELETED', 'message has been deleted')
        return problem(reply, request, 409, 'VERSION_CONFLICT', 'message was modified concurrently')
      }
      const updated = await getMessageWithReactions(deps.db, organizationId, messageId, userId)
      if (!updated) return problem(reply, request, 404, 'NOT_FOUND', 'message not found')
      assertResponse(deps.registry, MESSAGE_SCHEMA_ID, updated)
      void reply.header('etag', messageEtag(updated.version))
      return updated
    }
  )

  // Soft-delete a message (doc 33 §2). Auth message.read (membership); moderator-ness is
  // then resolved by probing the actor's channel.manage grant (mirrors the member-add
  // route's gate). The store allows author OR moderator and requires a reason for a
  // moderator deleting another user's message. 204 on success (idempotent no-op included).
  app.delete(
    '/v1/organizations/:organizationId/channels/:channelId/messages/:messageId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, messageId } = request.params as {
        organizationId: string
        channelId: string
        messageId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(messageId)
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
      const rawBody = request.body as { reason?: string } | undefined
      if (rawBody && rawBody.reason !== undefined && typeof rawBody.reason !== 'string')
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'reason must be a string')
      // Moderator-ness = the actor holds channel.manage; a non-grant is not an error here,
      // just "not a moderator" (the store still allows the author to delete their own).
      const manage = await authorizeSubjectForOrg(
        deps.db,
        { issuer: principal.issuer, subject: principal.subject },
        organizationId,
        'channel.manage'
      )
      const result = await deleteMessage(deps.db, {
        organizationId,
        channelId,
        messageId,
        actorUserId: authz.userId ?? organizationId,
        isModerator: manage.decision.allowed,
        ...(rawBody?.reason ? { reason: rawBody.reason } : {})
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'message not found')
        if (result.reason === 'moderator_reason_required')
          return problem(
            reply,
            request,
            400,
            'VALIDATION_FAILED',
            'a moderator deletion requires a reason'
          )
        return problem(
          reply,
          request,
          403,
          'FORBIDDEN',
          'only the author or a channel moderator may delete this message'
        )
      }
      void reply.code(204).send()
      return reply
    }
  )

  app.post('/v1/organizations/:organizationId/channels/:channelId/read', async (request, reply) => {
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
      'channel.read'
    )
    if (!authz) return reply
    const body = request.body as { lastReadMessageId?: string }
    if (
      !body ||
      typeof body.lastReadMessageId !== 'string' ||
      !UUID_PATTERN.test(body.lastReadMessageId)
    )
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'lastReadMessageId is required')
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      { organizationId, principalId: principal.subject, method: 'POST', route: CHANNEL_READ_ROUTE },
      request.body
    )
    if (!gate) return reply
    const respondCursor = (cursor: ReadCursorResource): ReadCursorResource => {
      assertResponse(deps.registry, READ_CURSOR_SCHEMA_ID, cursor)
      return cursor
    }
    if (gate.priorResourceId) {
      const existing = await getReadCursor(
        deps.db,
        organizationId,
        channelId,
        authz.userId ?? organizationId
      )
      if (existing) return respondCursor(existing)
    }
    const result = await markChannelRead(deps.db, {
      organizationId,
      channelId,
      userId: authz.userId ?? organizationId,
      lastReadMessageId: body.lastReadMessageId
    })
    if (!result.ok) {
      await gate.release()
      if (result.reason === 'not_a_member')
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      return problem(reply, request, 404, 'NOT_FOUND', `${result.reason}`)
    }
    await gate.complete(channelId)
    return respondCursor(result.cursor)
  })

  // Typing: ephemeral fire-and-forget. It writes NO row and NEVER touches the outbox
  // — it fires a bare pg_notify that the gateway relays to the channel's other members.
  // No idempotency (a repeat IS the point); rate-capped per user to prevent a flood.
  app.post(
    '/v1/organizations/:organizationId/channels/:channelId/typing',
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
      const userId = authz.userId ?? organizationId
      // Member gate: only a channel member may signal typing in it.
      const channel = await getChannelForMember(deps.db, organizationId, channelId, userId)
      if (!channel.ok) {
        if (channel.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      // Coalesce: drop (still 204) if this user pinged this channel within the window.
      const rateKey = `${userId}:${channelId}`
      const nowMs = Date.now()
      const last = typingLastFired.get(rateKey) ?? 0
      if (nowMs - last >= TYPING_COALESCE_MS) {
        typingLastFired.set(rateKey, nowMs)
        await fireEphemeralNotification(deps.db, {
          kind: 'typing',
          organizationId,
          channelId,
          userId,
          at: new Date(nowMs).toISOString()
        })
      }
      void reply.code(204).send()
      return reply
    }
  )

  // Reactions: durable add/remove facts on a message. add=idempotent (PK), member-gated;
  // both ride the message.updated invalidation (no new realtime). removeReaction is a
  // natural no-op idempotent (204 whether or not the reaction was present).
  app.post(
    '/v1/organizations/:organizationId/channels/:channelId/messages/:messageId/reactions',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, messageId } = request.params as {
        organizationId: string
        channelId: string
        messageId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(messageId)
      )
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'message.react'
      )
      if (!authz) return reply
      const body = request.body as { emoji?: string }
      if (!body || typeof body.emoji !== 'string' || !EMOJI_PATTERN.test(body.emoji))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'emoji is required (1-32 chars)')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: principal.subject,
          method: 'POST',
          route: CHANNEL_REACTIONS_ROUTE
        },
        request.body
      )
      if (!gate) return reply
      const userId = authz.userId ?? organizationId
      const respondMessage = async (): Promise<MessageResource | FastifyReply> => {
        const message = await getMessageWithReactions(deps.db, organizationId, messageId, userId)
        if (!message) return problem(reply, request, 404, 'NOT_FOUND', 'message not found')
        assertResponse(deps.registry, MESSAGE_SCHEMA_ID, message)
        return message
      }
      if (gate.priorResourceId) {
        return respondMessage()
      }
      const result = await addReaction(deps.db, {
        organizationId,
        channelId,
        messageId,
        userId,
        emoji: body.emoji
      })
      if (!result.ok) {
        await gate.release()
        if (result.reason === 'message_not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'message not found')
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      await gate.complete(messageId)
      return respondMessage()
    }
  )

  // removeReaction is idempotent by nature (no-op → 204), so it does NOT reserve an
  // idempotency key even though the contract declares the header on the DELETE.
  app.delete(
    '/v1/organizations/:organizationId/channels/:channelId/messages/:messageId/reactions',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, messageId } = request.params as {
        organizationId: string
        channelId: string
        messageId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(messageId)
      )
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'message.react'
      )
      if (!authz) return reply
      const { emoji } = request.query as { emoji?: string }
      if (typeof emoji !== 'string' || !EMOJI_PATTERN.test(emoji))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'emoji query param is required')
      const result = await removeReaction(deps.db, {
        organizationId,
        channelId,
        messageId,
        userId: authz.userId ?? organizationId,
        emoji
      })
      if (!result.ok) {
        if (result.reason === 'message_not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'message not found')
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      void reply.code(204).send()
      return reply
    }
  )

  // Pin a message (doc 33 §3). Auth message.post (a member-write action, like edit); the
  // store's membership gate is the real authority (v1: a member may pin). Idempotent 204.
  // reasons → HTTP: not_found 404, not_a_member 403, already_deleted 409 (a tombstone is
  // not pinnable), cap_exceeded 409 (the per-channel cap is reached).
  app.put(
    '/v1/organizations/:organizationId/channels/:channelId/messages/:messageId/pin',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, messageId } = request.params as {
        organizationId: string
        channelId: string
        messageId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(messageId)
      )
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
      const result = await pinMessage(deps.db, {
        organizationId,
        channelId,
        messageId,
        actorUserId: authz.userId ?? organizationId
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'message not found')
        if (result.reason === 'not_a_member')
          return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
        if (result.reason === 'already_deleted')
          return problem(
            reply,
            request,
            409,
            'MESSAGE_DELETED',
            'a deleted message cannot be pinned'
          )
        return problem(
          reply,
          request,
          409,
          'PIN_CAP_EXCEEDED',
          `a channel may pin at most ${MAX_PINS_PER_CHANNEL} messages`
        )
      }
      void reply.code(204).send()
      return reply
    }
  )

  // Unpin a message (doc 33 §3). Same member-gate; idempotent 204 whether or not a pin
  // existed. A non-member is 403.
  app.delete(
    '/v1/organizations/:organizationId/channels/:channelId/messages/:messageId/pin',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, messageId } = request.params as {
        organizationId: string
        channelId: string
        messageId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(messageId)
      )
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
      const result = await unpinMessage(deps.db, {
        organizationId,
        channelId,
        messageId,
        actorUserId: authz.userId ?? organizationId
      })
      if (!result.ok)
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      void reply.code(204).send()
      return reply
    }
  )

  // List a channel's pinned messages, most-recent-pin first (doc 33 §3). Auth message.read;
  // member-gated in the store. Each item is a message summary + pinnedBy/pinnedAt.
  app.get('/v1/organizations/:organizationId/channels/:channelId/pins', async (request, reply) => {
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
      'message.read'
    )
    if (!authz) return reply
    const result = await listPins(
      deps.db,
      organizationId,
      channelId,
      authz.userId ?? organizationId
    )
    if (!result.ok) {
      if (result.reason === 'channel_not_found')
        return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
      return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
    }
    const body = { items: result.pins }
    assertResponse(deps.registry, PINNED_MESSAGES_SCHEMA_ID, body)
    return body
  })

  // Convert a message into a delivery work item (doc 33 §4). This bridges collaboration ↔
  // delivery, so it crosses BOTH schemas' authz: a DUAL org-permission gate — message.read
  // (read the source) AND work_item.create (create the target). Both must pass; a member who
  // can read chat but lacks work_item.create is denied 403. The store then enforces channel
  // membership on the source. Idempotency-Key REQUIRED (a conversion is a create). Returns
  // 201 + Location to the new work item. reasons → HTTP: source_not_found 404,
  // source_forbidden 403, source_deleted 409, team_not_found / invalid_state /
  // project_not_found 422.
  app.post(
    '/v1/organizations/:organizationId/channels/:channelId/messages/:messageId/work-items',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, messageId } = request.params as {
        organizationId: string
        channelId: string
        messageId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(messageId)
      )
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      // Gate 1 — source: read permission on the message surface.
      const readAuthz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'message.read'
      )
      if (!readAuthz) return reply
      // Gate 2 — target: create permission on the delivery work-item surface. Denied here is
      // a 403 even though message.read passed (the conversion needs BOTH).
      const createAuthz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'work_item.create'
      )
      if (!createAuthz) return reply
      if (!validates(deps.registry, MESSAGE_CONVERSION_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid conversion request')
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: principal.subject,
          method: 'POST',
          route: MESSAGE_WORK_ITEMS_ROUTE
        },
        request.body
      )
      if (!gate) return reply
      const respondCreated = (workItem: WorkItemResource): WorkItemResource => {
        assertResponse(deps.registry, WORK_ITEM_SCHEMA_ID, workItem)
        void reply
          .code(201)
          .header('location', `/v1/organizations/${organizationId}/work-items/${workItem.id}`)
        return workItem
      }
      // Replay: the prior conversion produced this work item — return it, don't convert again.
      if (gate.priorResourceId) {
        const existing = await getWorkItem(deps.db, organizationId, gate.priorResourceId)
        if (existing) return respondCreated(existing)
      }
      const body = request.body as {
        teamId: string
        projectId?: string | null
        title?: string
        priority?: WorkItemPriority
        assigneeId?: string | null
      }
      const actorUserId = createAuthz.userId ?? organizationId
      const result = await convertMessageToWorkItem(deps.db, {
        organizationId,
        actorUserId,
        channelId,
        messageId,
        teamId: body.teamId,
        projectId: body.projectId,
        title: body.title,
        priority: body.priority,
        assigneeId: body.assigneeId
      })
      if (!result.ok) {
        await gate.release()
        if (result.reason === 'source_not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'source message not found')
        if (result.reason === 'source_forbidden')
          return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
        if (result.reason === 'source_deleted')
          return problem(reply, request, 409, 'MESSAGE_DELETED', 'a deleted message cannot convert')
        if (result.reason === 'team_not_found')
          return problem(reply, request, 422, 'NO_TEAM', 'team not found for work item')
        if (result.reason === 'project_not_found')
          return problem(reply, request, 422, 'NO_PROJECT', 'project not found for work item')
        return problem(reply, request, 422, 'INVALID_STATE', 'state is not in the team workflow')
      }
      await gate.complete(result.workItem.id)
      return respondCreated(result.workItem)
    }
  )

  // List the work items a message has been converted into (doc 33 §4). member-gated. Auth
  // message.read; each item is the created work item's id, who converted it, and when.
  app.get(
    '/v1/organizations/:organizationId/channels/:channelId/messages/:messageId/work-items',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, messageId } = request.params as {
        organizationId: string
        channelId: string
        messageId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(messageId)
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
      // Member gate: only a channel member may read the source and its conversion links.
      const channel = await getChannelForMember(
        deps.db,
        organizationId,
        channelId,
        authz.userId ?? organizationId
      )
      if (!channel.ok) {
        if (channel.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      const items = await listWorkItemLinksForMessage(deps.db, organizationId, messageId)
      return { items, nextCursor: null }
    }
  )
}
