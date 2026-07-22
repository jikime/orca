import { z } from 'zod'
import {
  PieChannelSchema,
  PieChatMemberSchema,
  PieChannelMemberSchema,
  type ChannelVisibility,
  type PieChannel,
  type PieChannelMember,
  type PieChannelUpdate,
  type PieChatMember
} from '../../shared/pie-chat-contract'
import {
  authHeaders,
  channelsBase,
  jsonHeaders,
  orgBase,
  PieChatError
} from './chat-control-plane-http'

// Channel creation, DM/group-DM creation, mute toggle, and the org member roster
// that feeds @-mention autocomplete and DM targeting.

export async function createChannel(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  input: { name: string; visibility?: ChannelVisibility; idempotencyKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<PieChannel> {
  const body: Record<string, unknown> = { name: input.name }
  if (input.visibility) {
    body.visibility = input.visibility
  }
  const response = await fetchImpl(channelsBase(apiBaseUrl, organizationId), {
    method: 'POST',
    headers: { ...jsonHeaders(accessToken), 'idempotency-key': input.idempotencyKey },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new PieChatError(`create channel failed with ${response.status}`, response.status)
  }
  const parsed = PieChannelSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('created channel response failed schema validation')
  }
  return parsed.data
}

export async function createDm(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  otherUserId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieChannel> {
  const response = await fetchImpl(`${orgBase(apiBaseUrl, organizationId)}/dms`, {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({ otherUserId })
  })
  if (!response.ok) {
    throw new PieChatError(`create dm failed with ${response.status}`, response.status)
  }
  const parsed = PieChannelSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('created dm response failed schema validation')
  }
  return parsed.data
}

export async function createGroupDm(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  participantUserIds: string[],
  fetchImpl: typeof fetch = fetch
): Promise<PieChannel> {
  const response = await fetchImpl(`${orgBase(apiBaseUrl, organizationId)}/group-dms`, {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({ participantUserIds })
  })
  if (!response.ok) {
    throw new PieChatError(`create group dm failed with ${response.status}`, response.status)
  }
  const parsed = PieChannelSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('created group dm response failed schema validation')
  }
  return parsed.data
}

export async function addChannelMember(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  userId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/members`,
    {
      method: 'POST',
      headers: jsonHeaders(accessToken),
      body: JSON.stringify({ userId })
    }
  )
  if (!response.ok) {
    throw new PieChatError(`add channel member failed with ${response.status}`, response.status)
  }
}

export async function updateChannel(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  input: { update: PieChannelUpdate; expectedVersion: number; idempotencyKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<PieChannel> {
  const response = await fetchImpl(`${channelsBase(apiBaseUrl, organizationId)}/${channelId}`, {
    method: 'PATCH',
    headers: {
      ...jsonHeaders(accessToken),
      'if-match': `"channel-${input.expectedVersion}"`,
      'idempotency-key': input.idempotencyKey
    },
    body: JSON.stringify(input.update)
  })
  if (!response.ok) {
    throw new PieChatError(`update channel failed with ${response.status}`, response.status)
  }
  const parsed = PieChannelSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('updated channel response failed schema validation')
  }
  return parsed.data
}

const ChannelMemberListSchema = z.object({ items: z.array(PieChannelMemberSchema) }).passthrough()

export async function listChannelMembers(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieChannelMember[]> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/members`,
    { headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`list channel members failed with ${response.status}`, response.status)
  }
  const parsed = ChannelMemberListSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('channel members response failed schema validation')
  }
  return parsed.data.items
}

export async function removeChannelMember(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  userId: string,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/members/${userId}`,
    {
      method: 'DELETE',
      headers: { ...authHeaders(accessToken), 'idempotency-key': idempotencyKey }
    }
  )
  if (!response.ok) {
    throw new PieChatError(`remove channel member failed with ${response.status}`, response.status)
  }
}

export async function muteChannel(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/mute`,
    {
      method: 'PUT',
      headers: authHeaders(accessToken)
    }
  )
  if (!response.ok) {
    throw new PieChatError(`mute channel failed with ${response.status}`, response.status)
  }
}

export async function unmuteChannel(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/mute`,
    {
      method: 'DELETE',
      headers: authHeaders(accessToken)
    }
  )
  if (!response.ok) {
    throw new PieChatError(`unmute channel failed with ${response.status}`, response.status)
  }
}

const MembershipListSchema = z
  .object({
    items: z.array(
      z.object({ userId: z.string(), displayName: z.string().optional() }).passthrough()
    )
  })
  .passthrough()

export async function listMembers(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieChatMember[]> {
  const response = await fetchImpl(`${orgBase(apiBaseUrl, organizationId)}/memberships`, {
    headers: authHeaders(accessToken)
  })
  if (!response.ok) {
    throw new PieChatError(`list members failed with ${response.status}`, response.status)
  }
  const parsed = MembershipListSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('members response failed schema validation')
  }
  // Older control planes may omit displayName, so mixed-version desktops retain
  // the short-id fallback while newer servers expose the identity profile name.
  return parsed.data.items
    .filter((item) => (item as { status?: string }).status !== 'revoked')
    .map(
      (item): PieChatMember =>
        PieChatMemberSchema.parse({
          userId: item.userId,
          displayName: item.displayName ?? item.userId.slice(0, 8)
        })
    )
}
