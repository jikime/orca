import type {
  ChannelVisibility,
  PieAttachmentDownload,
  PieAttachmentIntent,
  PieChannel,
  PieChannelAuditEntry,
  PieChannelExport,
  PieChannelMember,
  PieChannelNotificationLevel,
  PieChannelUpdate,
  PieChatListMessagesOptions,
  PieChatMember,
  PieChatMessagesChanged,
  PieChatNotificationClicked,
  PieChatPresenceChanged,
  PieChatTypingChanged,
  PieMessage,
  PieMessageListResponse,
  PieMessageSearchResponse,
  PieNotification,
  PieNotificationListResponse,
  PieNotificationPreferences,
  PieNotificationPreferencesUpdate,
  PiePinnedMessage,
  PieSendMessageOptions
} from './pie-chat-contract'

// Renderer-facing bridge. Tokens and org identity remain owned by Main, which
// resolves them from the authenticated desktop session for every invocation.
export type PieChatRendererApi = {
  listChannels: () => Promise<PieChannel[]>
  listMessages: (
    channelId: string,
    opts?: PieChatListMessagesOptions
  ) => Promise<PieMessageListResponse>
  getMessage: (channelId: string, messageId: string) => Promise<PieMessage>
  sendMessage: (
    channelId: string,
    body: string,
    opts?: PieSendMessageOptions,
    clientRequestId?: string
  ) => Promise<PieMessage>
  editMessage: (
    channelId: string,
    messageId: string,
    body: string,
    expectedVersion: number
  ) => Promise<PieMessage>
  deleteMessage: (channelId: string, messageId: string, reason?: string) => Promise<void>
  markRead: (channelId: string, lastReadMessageId: string) => Promise<void>
  addReaction: (channelId: string, messageId: string, emoji: string) => Promise<PieMessage>
  removeReaction: (channelId: string, messageId: string, emoji: string) => Promise<void>
  pinMessage: (channelId: string, messageId: string) => Promise<void>
  unpinMessage: (channelId: string, messageId: string) => Promise<void>
  listPins: (channelId: string) => Promise<PiePinnedMessage[]>
  createChannel: (name: string, visibility?: ChannelVisibility) => Promise<PieChannel>
  createDm: (otherUserId: string) => Promise<PieChannel>
  createGroupDm: (participantUserIds: string[]) => Promise<PieChannel>
  addChannelMember: (channelId: string, userId: string) => Promise<void>
  updateChannel: (
    channelId: string,
    update: PieChannelUpdate,
    expectedVersion: number
  ) => Promise<PieChannel>
  listChannelMembers: (channelId: string) => Promise<PieChannelMember[]>
  removeChannelMember: (channelId: string, userId: string) => Promise<void>
  listChannelAudit: (channelId: string) => Promise<PieChannelAuditEntry[]>
  exportChannel: (channelId: string) => Promise<PieChannelExport>
  applyChannelRetention: (channelId: string) => Promise<number>
  muteChannel: (channelId: string) => Promise<void>
  unmuteChannel: (channelId: string) => Promise<void>
  searchMessages: (query: string, cursor?: string) => Promise<PieMessageSearchResponse>
  listMembers: () => Promise<PieChatMember[]>
  uploadAttachment: (
    channelId: string,
    meta: { filename: string; contentType: string; byteSize: number },
    file: ArrayBuffer
  ) => Promise<PieAttachmentIntent>
  downloadAttachment: (channelId: string, attachmentId: string) => Promise<PieAttachmentDownload>
  listNotifications: () => Promise<PieNotificationListResponse>
  markNotificationRead: (notificationId: string) => Promise<PieNotification>
  markAllNotificationsRead: () => Promise<number>
  getNotificationPreferences: () => Promise<PieNotificationPreferences>
  updateNotificationPreferences: (
    update: PieNotificationPreferencesUpdate
  ) => Promise<PieNotificationPreferences>
  setChannelNotificationLevel: (
    channelId: string,
    level: PieChannelNotificationLevel
  ) => Promise<void>
  onNotificationClicked: (callback: (event: PieChatNotificationClicked) => void) => () => void
  onMessagesChanged: (callback: (event: PieChatMessagesChanged) => void) => () => void
  sendTyping: (channelId: string) => Promise<void>
  getPresenceSnapshot: () => Promise<string[]>
  onTypingChanged: (callback: (event: PieChatTypingChanged) => void) => () => void
  onPresenceChanged: (callback: (event: PieChatPresenceChanged) => void) => () => void
}
