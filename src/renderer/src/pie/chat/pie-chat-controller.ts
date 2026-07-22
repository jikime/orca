import type {
  PieChannel,
  PieChatMember,
  PieChatRendererApi,
  PieMessage,
  PieNotification,
  PieSendMessageOptions
} from '../../../../shared/pie-chat-contract'

export type TimelineMessage = PieMessage & {
  optimisticId?: string
  pending?: boolean
  failed?: boolean
  retryPayload?: {
    body: string
    opts?: PieSendMessageOptions
  }
}

export type PieChatController = {
  api: PieChatRendererApi
  currentUserId: string
  channels: PieChannel[]
  members: PieChatMember[]
  selectedChannelId: string | null
  messages: TimelineMessage[]
  unreadBoundaryMessageId: string | null
  notifications: PieNotification[]
  unreadNotificationCount: number
  onlineUserIds: ReadonlySet<string>
  typingUserIdsByChannel: ReadonlyMap<string, string[]>
  notifyTyping: (channelId: string) => void
  loadingChannels: boolean
  loadingMessages: boolean
  loadingOlderMessages: boolean
  hasOlderMessages: boolean
  sending: boolean
  error: string | null
  selectChannel: (channelId: string) => void
  selectChannelObject: (channel: PieChannel) => void
  replaceChannel: (channel: PieChannel) => void
  focusMessage: (message: PieMessage) => void
  sendMessage: (
    body: string,
    opts?: PieSendMessageOptions,
    clientRequestId?: string
  ) => Promise<void>
  retryMessage: (optimisticId: string) => Promise<void>
  dismissFailedMessage: (optimisticId: string) => void
  markReadThrough: (channelId: string, messageId: string) => Promise<void>
  toggleReaction: (messageId: string, emoji: string) => Promise<void>
  markNotificationRead: (notificationId: string) => Promise<void>
  markAllNotificationsRead: () => Promise<void>
  refresh: () => Promise<void>
  loadOlderMessages: () => Promise<void>
}
