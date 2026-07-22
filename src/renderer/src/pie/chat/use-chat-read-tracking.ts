import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  PieChannel,
  PieChatRendererApi,
  PieMessage
} from '../../../../shared/pie-chat-contract'

type ChatReadTracking = {
  unreadBoundaryMessageId: string | null
  captureUnreadBoundary: (channel: PieChannel | undefined, messages: PieMessage[]) => void
  markReadThrough: (channelId: string, messageId: string) => Promise<void>
  resetUnreadBoundary: () => void
}

export function findUnreadBoundary(
  channel: PieChannel | undefined,
  messages: PieMessage[]
): string | null {
  if (!channel?.unreadCount || messages.length === 0) {
    return null
  }
  if (!channel.lastReadMessageId) {
    return messages[0]?.id ?? null
  }
  const cursorIndex = messages.findIndex((message) => message.id === channel.lastReadMessageId)
  // When the cursor is older than the loaded page, everything currently visible is unread.
  return cursorIndex === -1 ? (messages[0]?.id ?? null) : (messages[cursorIndex + 1]?.id ?? null)
}

export function useChatReadTracking(
  api: PieChatRendererApi,
  setChannels: Dispatch<SetStateAction<PieChannel[]>>
): ChatReadTracking {
  const [unreadBoundaryMessageId, setUnreadBoundaryMessageId] = useState<string | null>(null)

  const captureUnreadBoundary = useCallback(
    (channel: PieChannel | undefined, messages: PieMessage[]): void => {
      setUnreadBoundaryMessageId(findUnreadBoundary(channel, messages))
    },
    []
  )

  const markReadThrough = useCallback(
    async (channelId: string, messageId: string): Promise<void> => {
      await api.markRead(channelId, messageId)
      setChannels((current) =>
        current.map((channel) =>
          channel.id === channelId
            ? { ...channel, unreadCount: 0, lastReadMessageId: messageId }
            : channel
        )
      )
      setUnreadBoundaryMessageId(null)
    },
    [api, setChannels]
  )

  const resetUnreadBoundary = useCallback((): void => setUnreadBoundaryMessageId(null), [])

  return {
    unreadBoundaryMessageId,
    captureUnreadBoundary,
    markReadThrough,
    resetUnreadBoundary
  }
}
