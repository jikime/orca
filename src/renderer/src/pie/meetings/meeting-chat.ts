import type { PieChannel, PieMessage } from '../../../../shared/pie-chat-contract'
import { apiPostWithIdempotencyKey } from '../control-plane/pie-api-client'
import { queuePieChatNavigation } from '../chat/pie-chat-navigation'
import type { MeetingResource } from './meeting-types'

function channelName(meeting: MeetingResource): string {
  return `meeting-${meeting.title.trim()}`.slice(0, 120)
}

export async function ensureMeetingChannel(meeting: MeetingResource): Promise<PieChannel> {
  return apiPostWithIdempotencyKey<PieChannel>(
    '/channels',
    {
      name: channelName(meeting),
      visibility: 'internal',
      scopeType: 'meeting',
      scopeId: meeting.id
    },
    `meeting-channel:${meeting.id}`
  )
}

export async function openMeetingConversation(meeting: MeetingResource): Promise<void> {
  const channel = await ensureMeetingChannel(meeting)
  queuePieChatNavigation({ channelId: channel.id, channel })
}

export type PublishedMeetingMessage = { channel: PieChannel; message: PieMessage }

// Artifact-specific deterministic keys make a repeated publish click return the
// original message instead of duplicating a recap in the meeting channel.
export async function publishMeetingMessage(
  meeting: MeetingResource,
  artifactKey: string,
  body: string
): Promise<PublishedMeetingMessage> {
  const channel = await ensureMeetingChannel(meeting)
  const message = await apiPostWithIdempotencyKey<PieMessage>(
    `/channels/${channel.id}/messages`,
    { body, visibility: 'internal' },
    `meeting-publish:${artifactKey}`
  )
  return { channel, message }
}

export function openPublishedMeetingMessage(published: PublishedMeetingMessage): void {
  queuePieChatNavigation({
    channelId: published.channel.id,
    messageId: published.message.id,
    channel: published.channel
  })
}
