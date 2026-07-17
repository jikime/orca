// Zod-free wire surface for the Pie chat IPC bridge. The SANDBOXED preload
// imports channel names + types from HERE (not from pie-chat-contract, whose
// runtime zod schemas cannot be `require`d in the sandbox). Validation lives in
// Main, so the preload only needs these plain string constants + erasable types.

export const PIE_CHAT_LIST_CHANNELS_CHANNEL = 'pie:chat:list-channels'
export const PIE_CHAT_LIST_MESSAGES_CHANNEL = 'pie:chat:list-messages'
export const PIE_CHAT_SEND_MESSAGE_CHANNEL = 'pie:chat:send-message'
export const PIE_CHAT_EDIT_MESSAGE_CHANNEL = 'pie:chat:edit-message'
export const PIE_CHAT_DELETE_MESSAGE_CHANNEL = 'pie:chat:delete-message'
export const PIE_CHAT_MARK_READ_CHANNEL = 'pie:chat:mark-read'
export const PIE_CHAT_ADD_REACTION_CHANNEL = 'pie:chat:add-reaction'
export const PIE_CHAT_REMOVE_REACTION_CHANNEL = 'pie:chat:remove-reaction'
export const PIE_CHAT_PIN_MESSAGE_CHANNEL = 'pie:chat:pin-message'
export const PIE_CHAT_UNPIN_MESSAGE_CHANNEL = 'pie:chat:unpin-message'
export const PIE_CHAT_LIST_PINS_CHANNEL = 'pie:chat:list-pins'
export const PIE_CHAT_CREATE_CHANNEL_CHANNEL = 'pie:chat:create-channel'
export const PIE_CHAT_CREATE_DM_CHANNEL = 'pie:chat:create-dm'
export const PIE_CHAT_CREATE_GROUP_DM_CHANNEL = 'pie:chat:create-group-dm'
export const PIE_CHAT_MUTE_CHANNEL_CHANNEL = 'pie:chat:mute-channel'
export const PIE_CHAT_UNMUTE_CHANNEL_CHANNEL = 'pie:chat:unmute-channel'
export const PIE_CHAT_SEARCH_MESSAGES_CHANNEL = 'pie:chat:search-messages'
export const PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL = 'pie:chat:create-attachment-intent'
export const PIE_CHAT_DOWNLOAD_ATTACHMENT_CHANNEL = 'pie:chat:download-attachment'
export const PIE_CHAT_LIST_MEMBERS_CHANNEL = 'pie:chat:list-members'
export const PIE_CHAT_MESSAGES_CHANGED_CHANNEL = 'pie:chat:messages-changed'

// Type-only re-exports (erased at runtime, so importing this module never pulls
// the zod contract into the preload bundle).
export type {
  PieAttachmentDownload,
  PieAttachmentIntent,
  PieChannel,
  PieChatListMessagesOptions,
  PieChatMember,
  PieChatMessagesChanged,
  PieChatRendererApi,
  PieMessage,
  PieMessageListResponse,
  PieMessageSearchResponse,
  PiePinnedMessage,
  PieSendMessageOptions
} from './pie-chat-contract'
