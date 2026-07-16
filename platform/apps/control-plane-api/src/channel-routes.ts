import {
  addReaction,
  createChannel,
  getChannelForMember,
  getMessageWithReactions,
  getReadCursor,
  listChannelMessages,
  listChannels,
  markChannelRead,
  postMessage,
  removeReaction,
  type ChannelResource,
  type ChannelVisibility,
  type MessageResource,
  type PieDatabase,
  type ReadCursorResource
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const CHANNEL_SCHEMA_ID = 'https://schemas.pielab.ai/resources/channel.v1.schema.json'
const CHANNEL_CREATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/channel-create.v1.schema.json'
const MESSAGE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/message.v1.schema.json'
const MESSAGE_CREATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/message-create.v1.schema.json'
const READ_CURSOR_SCHEMA_ID = 'https://schemas.pielab.ai/resources/read-cursor.v1.schema.json'
const CHANNELS_ROUTE = '/v1/organizations/{organizationId}/channels'
const CHANNEL_MESSAGES_ROUTE = '/v1/organizations/{organizationId}/channels/{channelId}/messages'
const CHANNEL_REACTIONS_ROUTE =
  '/v1/organizations/{organizationId}/channels/{channelId}/messages/{messageId}/reactions'
const CHANNEL_READ_ROUTE = '/v1/organizations/{organizationId}/channels/{channelId}/read'
const EMOJI_PATTERN = /^.{1,32}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ChannelRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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
    const items = authz.userId ? await listChannels(deps.db, organizationId, authz.userId) : []
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
      }
      const result = await postMessage(deps.db, {
        organizationId,
        channelId,
        authorUserId: userId,
        body: body.body,
        visibility: body.visibility,
        ...(body.threadRootMessageId ? { threadRootMessageId: body.threadRootMessageId } : {})
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
}
