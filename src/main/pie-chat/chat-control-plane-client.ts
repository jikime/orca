import {
  PieChannelListResponseSchema,
  PieChatListMessagesOptionsSchema,
  PieMessageListResponseSchema,
  PieMessageSchema,
  PieSendMessageOptionsSchema,
  type PieChannel,
  type PieChatListMessagesOptions,
  type PieMessage,
  type PieMessageListResponse,
  type PieSendMessageOptions
} from '../../shared/pie-chat-contract'
import { authHeaders, channelsBase, jsonHeaders, PieChatError } from './chat-control-plane-http'

// Thin client for the core Control Plane collaboration (chat) endpoints:
// channels + messages. Reaction/pin, channel-admin, and search/attachment
// operations live in sibling modules so no one file outgrows the size budget.

export { PieChatError } from './chat-control-plane-http'

export async function listChannels(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieChannel[]> {
  const response = await fetchImpl(channelsBase(apiBaseUrl, organizationId), {
    headers: authHeaders(accessToken)
  })
  if (!response.ok) {
    throw new PieChatError(`list channels failed with ${response.status}`, response.status)
  }
  const parsed = PieChannelListResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('channel list response failed schema validation')
  }
  return parsed.data.items
}

export async function listMessages(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  opts: PieChatListMessagesOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<PieMessageListResponse> {
  const options = PieChatListMessagesOptionsSchema.parse(opts)
  const query = new URLSearchParams()
  if (options.limit !== undefined) {
    query.set('limit', String(options.limit))
  }
  if (options.cursor !== undefined) {
    query.set('cursor', options.cursor)
  }
  if (options.threadRoot !== undefined) {
    query.set('threadRoot', options.threadRoot)
  }
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/messages${suffix}`,
    { headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`list messages failed with ${response.status}`, response.status)
  }
  const parsed = PieMessageListResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('message list response failed schema validation')
  }
  return parsed.data
}

export async function sendMessage(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  input: { body: string; idempotencyKey: string; opts?: PieSendMessageOptions },
  fetchImpl: typeof fetch = fetch
): Promise<PieMessage> {
  // threadRootMessageId/mentions/attachmentIds ride the same POST body; the
  // backend resolves mentions and drops non-members. Validate the extra fields.
  const opts = input.opts ? PieSendMessageOptionsSchema.parse(input.opts) : {}
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/messages`,
    {
      method: 'POST',
      // Idempotency-Key makes a retried send safe: the server returns the prior
      // message instead of creating a duplicate.
      headers: { ...jsonHeaders(accessToken), 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({ body: input.body, ...opts })
    }
  )
  if (!response.ok) {
    throw new PieChatError(`send message failed with ${response.status}`, response.status)
  }
  const parsed = PieMessageSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('sent message response failed schema validation')
  }
  return parsed.data
}

export async function editMessage(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  messageId: string,
  input: { body: string; expectedVersion: number },
  fetchImpl: typeof fetch = fetch
): Promise<PieMessage> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/messages/${messageId}`,
    {
      method: 'PATCH',
      // OCC: If-Match carries the expected message version; the server rejects a
      // concurrent edit with 409 rather than silently clobbering.
      headers: { ...jsonHeaders(accessToken), 'if-match': `"message-${input.expectedVersion}"` },
      body: JSON.stringify({ body: input.body })
    }
  )
  if (!response.ok) {
    throw new PieChatError(`edit message failed with ${response.status}`, response.status)
  }
  const parsed = PieMessageSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('edited message response failed schema validation')
  }
  return parsed.data
}

export async function deleteMessage(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  messageId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/messages/${messageId}`,
    { method: 'DELETE', headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`delete message failed with ${response.status}`, response.status)
  }
}

export async function markRead(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  input: { lastReadMessageId: string; idempotencyKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/read`,
    {
      method: 'POST',
      headers: { ...jsonHeaders(accessToken), 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({ lastReadMessageId: input.lastReadMessageId })
    }
  )
  if (!response.ok) {
    throw new PieChatError(`mark read failed with ${response.status}`, response.status)
  }
}

export async function sendTyping(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  // Ephemeral fire-and-forget; the server coalesces per user/channel and 204s.
  // No body — use authHeaders (not jsonHeaders): an application/json content-type
  // with an empty body makes Fastify's parser 400 before the handler runs.
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/typing`,
    { method: 'POST', headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`typing signal failed with ${response.status}`, response.status)
  }
}
