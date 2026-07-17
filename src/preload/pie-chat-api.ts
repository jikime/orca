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
  PIE_CHAT_LIST_PINS_CHANNEL,
  PIE_CHAT_MARK_READ_CHANNEL,
  PIE_CHAT_MESSAGES_CHANGED_CHANNEL,
  PIE_CHAT_MUTE_CHANNEL_CHANNEL,
  PIE_CHAT_PIN_MESSAGE_CHANNEL,
  PIE_CHAT_REMOVE_REACTION_CHANNEL,
  PIE_CHAT_SEARCH_MESSAGES_CHANNEL,
  PIE_CHAT_SEND_MESSAGE_CHANNEL,
  PIE_CHAT_UNMUTE_CHANNEL_CHANNEL,
  PIE_CHAT_UNPIN_MESSAGE_CHANNEL,
  PieAttachmentDownloadSchema,
  PieAttachmentIntentSchema,
  PieChannelSchema,
  PieChatMemberSchema,
  PieChatMessagesChangedSchema,
  PieMessageListResponseSchema,
  PieMessageSchema,
  PieMessageSearchResponseSchema,
  PiePinnedMessageSchema,
  type PieChatRendererApi
} from '../shared/pie-chat-contract'
import { z } from 'zod'

type PieChatIpcRenderer = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>

const channelArraySchema = z.array(PieChannelSchema)
const memberArraySchema = z.array(PieChatMemberSchema)
const pinArraySchema = z.array(PiePinnedMessageSchema)

export function createPieChatPreloadApi(ipc: PieChatIpcRenderer): PieChatRendererApi {
  return {
    listChannels: async () =>
      channelArraySchema.parse(await ipc.invoke(PIE_CHAT_LIST_CHANNELS_CHANNEL)),
    listMessages: async (channelId, opts) =>
      PieMessageListResponseSchema.parse(
        await ipc.invoke(PIE_CHAT_LIST_MESSAGES_CHANNEL, { channelId, opts })
      ),
    sendMessage: async (channelId, body, opts) =>
      PieMessageSchema.parse(
        await ipc.invoke(PIE_CHAT_SEND_MESSAGE_CHANNEL, { channelId, body, opts })
      ),
    editMessage: async (channelId, messageId, body, expectedVersion) =>
      PieMessageSchema.parse(
        await ipc.invoke(PIE_CHAT_EDIT_MESSAGE_CHANNEL, {
          channelId,
          messageId,
          body,
          expectedVersion
        })
      ),
    deleteMessage: async (channelId, messageId) => {
      await ipc.invoke(PIE_CHAT_DELETE_MESSAGE_CHANNEL, { channelId, messageId })
    },
    markRead: async (channelId, lastReadMessageId) => {
      await ipc.invoke(PIE_CHAT_MARK_READ_CHANNEL, { channelId, lastReadMessageId })
    },
    addReaction: async (channelId, messageId, emoji) =>
      PieMessageSchema.parse(
        await ipc.invoke(PIE_CHAT_ADD_REACTION_CHANNEL, { channelId, messageId, emoji })
      ),
    removeReaction: async (channelId, messageId, emoji) => {
      await ipc.invoke(PIE_CHAT_REMOVE_REACTION_CHANNEL, { channelId, messageId, emoji })
    },
    pinMessage: async (channelId, messageId) => {
      await ipc.invoke(PIE_CHAT_PIN_MESSAGE_CHANNEL, { channelId, messageId })
    },
    unpinMessage: async (channelId, messageId) => {
      await ipc.invoke(PIE_CHAT_UNPIN_MESSAGE_CHANNEL, { channelId, messageId })
    },
    listPins: async (channelId) =>
      pinArraySchema.parse(await ipc.invoke(PIE_CHAT_LIST_PINS_CHANNEL, { channelId })),
    createChannel: async (name, visibility) =>
      PieChannelSchema.parse(
        await ipc.invoke(PIE_CHAT_CREATE_CHANNEL_CHANNEL, { name, visibility })
      ),
    createDm: async (otherUserId) =>
      PieChannelSchema.parse(await ipc.invoke(PIE_CHAT_CREATE_DM_CHANNEL, { otherUserId })),
    createGroupDm: async (participantUserIds) =>
      PieChannelSchema.parse(
        await ipc.invoke(PIE_CHAT_CREATE_GROUP_DM_CHANNEL, { participantUserIds })
      ),
    muteChannel: async (channelId) => {
      await ipc.invoke(PIE_CHAT_MUTE_CHANNEL_CHANNEL, { channelId })
    },
    unmuteChannel: async (channelId) => {
      await ipc.invoke(PIE_CHAT_UNMUTE_CHANNEL_CHANNEL, { channelId })
    },
    searchMessages: async (query, cursor) =>
      PieMessageSearchResponseSchema.parse(
        await ipc.invoke(PIE_CHAT_SEARCH_MESSAGES_CHANNEL, { query, cursor })
      ),
    listMembers: async () =>
      memberArraySchema.parse(await ipc.invoke(PIE_CHAT_LIST_MEMBERS_CHANNEL)),
    uploadAttachment: async (channelId, meta, file) =>
      PieAttachmentIntentSchema.parse(
        await ipc.invoke(PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL, {
          channelId,
          filename: meta.filename,
          contentType: meta.contentType,
          byteSize: meta.byteSize,
          file
        })
      ),
    downloadAttachment: async (channelId, attachmentId) =>
      PieAttachmentDownloadSchema.parse(
        await ipc.invoke(PIE_CHAT_DOWNLOAD_ATTACHMENT_CHANNEL, { channelId, attachmentId })
      ),
    onMessagesChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, input: unknown): void => {
        const parsed = PieChatMessagesChangedSchema.safeParse(input)
        if (parsed.success) {
          callback(parsed.data)
        }
      }
      ipc.on(PIE_CHAT_MESSAGES_CHANGED_CHANNEL, listener)
      return () => ipc.removeListener(PIE_CHAT_MESSAGES_CHANGED_CHANNEL, listener)
    }
  }
}
