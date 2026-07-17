import type { IpcRenderer, IpcRendererEvent } from 'electron'
import {
  PIE_CHAT_DELETE_MESSAGE_CHANNEL,
  PIE_CHAT_EDIT_MESSAGE_CHANNEL,
  PIE_CHAT_LIST_CHANNELS_CHANNEL,
  PIE_CHAT_LIST_MESSAGES_CHANNEL,
  PIE_CHAT_MARK_READ_CHANNEL,
  PIE_CHAT_MESSAGES_CHANGED_CHANNEL,
  PIE_CHAT_SEND_MESSAGE_CHANNEL,
  PieChannelSchema,
  PieChatMessagesChangedSchema,
  PieMessageListResponseSchema,
  PieMessageSchema,
  type PieChatRendererApi
} from '../shared/pie-chat-contract'
import { z } from 'zod'

type PieChatIpcRenderer = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>

const channelArraySchema = z.array(PieChannelSchema)

export function createPieChatPreloadApi(ipc: PieChatIpcRenderer): PieChatRendererApi {
  return {
    listChannels: async () =>
      channelArraySchema.parse(await ipc.invoke(PIE_CHAT_LIST_CHANNELS_CHANNEL)),
    listMessages: async (channelId, opts) =>
      PieMessageListResponseSchema.parse(
        await ipc.invoke(PIE_CHAT_LIST_MESSAGES_CHANNEL, { channelId, opts })
      ),
    sendMessage: async (channelId, body) =>
      PieMessageSchema.parse(await ipc.invoke(PIE_CHAT_SEND_MESSAGE_CHANNEL, { channelId, body })),
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
