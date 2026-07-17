import {
  PieMessageSchema,
  PiePinListResponseSchema,
  type PieMessage,
  type PiePinnedMessage
} from '../../shared/pie-chat-contract'
import { authHeaders, channelsBase, jsonHeaders, PieChatError } from './chat-control-plane-http'

// Reactions and pins. Both mutate a message and the backend emits a 'message'
// resource-change, so the realtime nudge refreshes every viewer's timeline.

function messageBase(
  apiBaseUrl: string,
  organizationId: string,
  channelId: string,
  messageId: string
): string {
  return `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/messages/${messageId}`
}

export async function addReaction(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  messageId: string,
  input: { emoji: string; idempotencyKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<PieMessage> {
  const response = await fetchImpl(
    `${messageBase(apiBaseUrl, organizationId, channelId, messageId)}/reactions`,
    {
      method: 'POST',
      // Idempotency-Key: a retried add does not double-count the same reaction.
      headers: { ...jsonHeaders(accessToken), 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({ emoji: input.emoji })
    }
  )
  if (!response.ok) {
    throw new PieChatError(`add reaction failed with ${response.status}`, response.status)
  }
  const parsed = PieMessageSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('reaction response failed schema validation')
  }
  return parsed.data
}

export async function removeReaction(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  messageId: string,
  emoji: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  // The emoji rides as a query param, not a body — matches the backend's DELETE.
  const query = new URLSearchParams({ emoji }).toString()
  const response = await fetchImpl(
    `${messageBase(apiBaseUrl, organizationId, channelId, messageId)}/reactions?${query}`,
    { method: 'DELETE', headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`remove reaction failed with ${response.status}`, response.status)
  }
}

export async function pinMessage(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  messageId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `${messageBase(apiBaseUrl, organizationId, channelId, messageId)}/pin`,
    { method: 'PUT', headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`pin message failed with ${response.status}`, response.status)
  }
}

export async function unpinMessage(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  messageId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `${messageBase(apiBaseUrl, organizationId, channelId, messageId)}/pin`,
    { method: 'DELETE', headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`unpin message failed with ${response.status}`, response.status)
  }
}

export async function listPins(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PiePinnedMessage[]> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/pins`,
    { headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`list pins failed with ${response.status}`, response.status)
  }
  const parsed = PiePinListResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('pins response failed schema validation')
  }
  return parsed.data.items
}
