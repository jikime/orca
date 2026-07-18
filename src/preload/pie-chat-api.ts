import type { IpcRenderer, IpcRendererEvent } from 'electron'
import {
  PIE_CHAT_ADD_REACTION_CHANNEL,
  PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL,
  PIE_CHAT_CREATE_CHANNEL_CHANNEL,
  PIE_CHAT_CREATE_DM_CHANNEL,
  PIE_CHAT_CREATE_GROUP_DM_CHANNEL,
  PIE_CHAT_DELETE_MESSAGE_CHANNEL,
  PIE_CHAT_DOWNLOAD_ATTACHMENT_CHANNEL,
  PIE_CHAT_EDIT_MESSAGE_CHANNEL,
  PIE_CHAT_LIST_CHANNELS_CHANNEL,
  PIE_CHAT_LIST_MEMBERS_CHANNEL,
  PIE_CHAT_LIST_MESSAGES_CHANNEL,
  PIE_CHAT_LIST_NOTIFICATIONS_CHANNEL,
  PIE_CHAT_LIST_PINS_CHANNEL,
  PIE_CHAT_MARK_ALL_NOTIFICATIONS_READ_CHANNEL,
  PIE_CHAT_MARK_NOTIFICATION_READ_CHANNEL,
  PIE_CHAT_MARK_READ_CHANNEL,
  PIE_CHAT_MESSAGES_CHANGED_CHANNEL,
  PIE_CHAT_MUTE_CHANNEL_CHANNEL,
  PIE_CHAT_PIN_MESSAGE_CHANNEL,
  PIE_CHAT_PRESENCE_CHANGED_CHANNEL,
  PIE_CHAT_REMOVE_REACTION_CHANNEL,
  PIE_CHAT_SEARCH_MESSAGES_CHANNEL,
  PIE_CHAT_SEND_MESSAGE_CHANNEL,
  PIE_CHAT_SEND_TYPING_CHANNEL,
  PIE_CHAT_TYPING_CHANGED_CHANNEL,
  PIE_CHAT_UNMUTE_CHANNEL_CHANNEL,
  PIE_CHAT_UNPIN_MESSAGE_CHANNEL,
  type PieAttachmentDownload,
  type PieAttachmentIntent,
  type PieChannel,
  type PieChatMember,
  type PieChatMessagesChanged,
  type PieChatPresenceChanged,
  type PieChatRendererApi,
  type PieChatTypingChanged,
  type PieMessage,
  type PieMessageListResponse,
  type PieMessageSearchResponse,
  type PieNotification,
  type PieNotificationListResponse,
  type PiePinnedMessage
} from '../shared/pie-chat-ipc-channels'

type PieChatIpcRenderer = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>

// Why: this bridge runs in the SANDBOXED preload, which cannot `require('zod')`
// (deps are externalized). Validation is the Main process's job — the chat IPC
// handlers + control-plane client already zod-validate every payload — so the
// preload only forwards typed IPC results across the trust boundary.
export function createPieChatPreloadApi(ipc: PieChatIpcRenderer): PieChatRendererApi {
  return {
    listChannels: () => ipc.invoke(PIE_CHAT_LIST_CHANNELS_CHANNEL) as Promise<PieChannel[]>,
    listMessages: (channelId, opts) =>
      ipc.invoke(PIE_CHAT_LIST_MESSAGES_CHANNEL, {
        channelId,
        opts
      }) as Promise<PieMessageListResponse>,
    sendMessage: (channelId, body, opts) =>
      ipc.invoke(PIE_CHAT_SEND_MESSAGE_CHANNEL, { channelId, body, opts }) as Promise<PieMessage>,
    editMessage: (channelId, messageId, body, expectedVersion) =>
      ipc.invoke(PIE_CHAT_EDIT_MESSAGE_CHANNEL, {
        channelId,
        messageId,
        body,
        expectedVersion
      }) as Promise<PieMessage>,
    deleteMessage: async (channelId, messageId) => {
      await ipc.invoke(PIE_CHAT_DELETE_MESSAGE_CHANNEL, { channelId, messageId })
    },
    markRead: async (channelId, lastReadMessageId) => {
      await ipc.invoke(PIE_CHAT_MARK_READ_CHANNEL, { channelId, lastReadMessageId })
    },
    addReaction: (channelId, messageId, emoji) =>
      ipc.invoke(PIE_CHAT_ADD_REACTION_CHANNEL, {
        channelId,
        messageId,
        emoji
      }) as Promise<PieMessage>,
    removeReaction: async (channelId, messageId, emoji) => {
      await ipc.invoke(PIE_CHAT_REMOVE_REACTION_CHANNEL, { channelId, messageId, emoji })
    },
    pinMessage: async (channelId, messageId) => {
      await ipc.invoke(PIE_CHAT_PIN_MESSAGE_CHANNEL, { channelId, messageId })
    },
    unpinMessage: async (channelId, messageId) => {
      await ipc.invoke(PIE_CHAT_UNPIN_MESSAGE_CHANNEL, { channelId, messageId })
    },
    listPins: (channelId) =>
      ipc.invoke(PIE_CHAT_LIST_PINS_CHANNEL, { channelId }) as Promise<PiePinnedMessage[]>,
    createChannel: (name, visibility) =>
      ipc.invoke(PIE_CHAT_CREATE_CHANNEL_CHANNEL, { name, visibility }) as Promise<PieChannel>,
    createDm: (otherUserId) =>
      ipc.invoke(PIE_CHAT_CREATE_DM_CHANNEL, { otherUserId }) as Promise<PieChannel>,
    createGroupDm: (participantUserIds) =>
      ipc.invoke(PIE_CHAT_CREATE_GROUP_DM_CHANNEL, { participantUserIds }) as Promise<PieChannel>,
    muteChannel: async (channelId) => {
      await ipc.invoke(PIE_CHAT_MUTE_CHANNEL_CHANNEL, { channelId })
    },
    unmuteChannel: async (channelId) => {
      await ipc.invoke(PIE_CHAT_UNMUTE_CHANNEL_CHANNEL, { channelId })
    },
    searchMessages: (query, cursor) =>
      ipc.invoke(PIE_CHAT_SEARCH_MESSAGES_CHANNEL, {
        query,
        cursor
      }) as Promise<PieMessageSearchResponse>,
    listMembers: () => ipc.invoke(PIE_CHAT_LIST_MEMBERS_CHANNEL) as Promise<PieChatMember[]>,
    uploadAttachment: (channelId, meta, file) =>
      ipc.invoke(PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL, {
        channelId,
        filename: meta.filename,
        contentType: meta.contentType,
        byteSize: meta.byteSize,
        file
      }) as Promise<PieAttachmentIntent>,
    downloadAttachment: (channelId, attachmentId) =>
      ipc.invoke(PIE_CHAT_DOWNLOAD_ATTACHMENT_CHANNEL, {
        channelId,
        attachmentId
      }) as Promise<PieAttachmentDownload>,
    listNotifications: () =>
      ipc.invoke(PIE_CHAT_LIST_NOTIFICATIONS_CHANNEL) as Promise<PieNotificationListResponse>,
    markNotificationRead: (notificationId) =>
      ipc.invoke(PIE_CHAT_MARK_NOTIFICATION_READ_CHANNEL, {
        notificationId
      }) as Promise<PieNotification>,
    markAllNotificationsRead: () =>
      ipc.invoke(PIE_CHAT_MARK_ALL_NOTIFICATIONS_READ_CHANNEL) as Promise<number>,
    onMessagesChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, input: unknown): void => {
        // Trusted boundary: Main emits a validated PieChatMessagesChanged payload.
        callback(input as PieChatMessagesChanged)
      }
      ipc.on(PIE_CHAT_MESSAGES_CHANGED_CHANNEL, listener)
      return () => ipc.removeListener(PIE_CHAT_MESSAGES_CHANGED_CHANNEL, listener)
    },
    sendTyping: async (channelId) => {
      await ipc.invoke(PIE_CHAT_SEND_TYPING_CHANNEL, { channelId })
    },
    onTypingChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, input: unknown): void => {
        // Trusted boundary: Main emits a validated PieChatTypingChanged payload.
        callback(input as PieChatTypingChanged)
      }
      ipc.on(PIE_CHAT_TYPING_CHANGED_CHANNEL, listener)
      return () => ipc.removeListener(PIE_CHAT_TYPING_CHANGED_CHANNEL, listener)
    },
    onPresenceChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, input: unknown): void => {
        // Trusted boundary: Main emits a validated PieChatPresenceChanged payload.
        callback(input as PieChatPresenceChanged)
      }
      ipc.on(PIE_CHAT_PRESENCE_CHANGED_CHANNEL, listener)
      return () => ipc.removeListener(PIE_CHAT_PRESENCE_CHANGED_CHANNEL, listener)
    }
  }
}
