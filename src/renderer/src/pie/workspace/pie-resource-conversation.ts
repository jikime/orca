import type { PieChannel } from '../../../../shared/pie-chat-contract'
import { queuePieChatNavigation } from '../chat/pie-chat-navigation'
import { apiPost } from '../control-plane/pie-api-client'

export async function openPieResourceConversation({
  scopeType,
  resourceId,
  label
}: {
  scopeType: 'project' | 'customer' | 'ticket'
  resourceId: string
  label: string
}): Promise<void> {
  const channels = await window.api.pie.chat.listChannels()
  let channel = channels.find((item) => item.scopeType === scopeType && item.scopeId === resourceId)
  if (!channel) {
    channel = await apiPost<PieChannel>('/channels', {
      name: label.trim().slice(0, 120),
      scopeType,
      scopeId: resourceId,
      visibility: scopeType === 'customer' ? 'customer' : 'internal'
    })
  }
  queuePieChatNavigation({ channelId: channel.id, channel })
}
