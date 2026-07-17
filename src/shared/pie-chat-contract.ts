import { z } from 'zod'

// IPC channel names for the Pie collaboration chat surface. Invoke channels are
// request/response; the changed channel is a Main->renderer push nudge.
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

// Resource types the chat surface reacts to (subset of the realtime union). A
// realtime resource.changed of any of these nudges the timeline to refetch;
// reactions/pins/edits/deletes all arrive as a 'message' change.
export const PIE_CHAT_REALTIME_RESOURCE_TYPES = new Set<string>([
  'channel',
  'channel_member',
  'message',
  'read_cursor',
  'notification'
])

const opaqueIdSchema = z.string().uuid()

export const ChannelVisibilitySchema = z.enum(['internal', 'project', 'customer'])
export const ChannelKindSchema = z.enum(['channel', 'dm'])

// Mirrors ChannelResource from @pie/persistence. Passthrough so an additive
// optional field from a newer control-plane does not fail client validation.
export const PieChannelSchema = z
  .object({
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    name: z.string(),
    kind: ChannelKindSchema,
    scopeType: z.string(),
    scopeId: z.string().nullable(),
    visibility: ChannelVisibilitySchema,
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .passthrough()

export const PieMessageReactionSchema = z
  .object({
    emoji: z.string(),
    count: z.number().int(),
    reactedByMe: z.boolean()
  })
  .passthrough()

export const PieMessageAttachmentSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    contentType: z.string(),
    byteSize: z.number().int()
  })
  .passthrough()

// Mirrors MessageResource from @pie/persistence, including the edited/tombstone
// and OCC version fields the timeline renders. Passthrough for forward-compat.
export const PieMessageSchema = z
  .object({
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    channelId: opaqueIdSchema,
    authorId: opaqueIdSchema,
    body: z.string(),
    visibility: ChannelVisibilitySchema,
    version: z.number().int(),
    threadRootMessageId: z.string().nullable(),
    replyCount: z.number().int(),
    reactions: z.array(PieMessageReactionSchema),
    attachments: z.array(PieMessageAttachmentSchema),
    createdAt: z.string(),
    edited: z.boolean(),
    revisionCount: z.number().int(),
    deleted: z.boolean(),
    deletedAt: z.string().nullable(),
    deletedBy: z.string().nullable(),
    deletionReason: z.string().nullable(),
    pinned: z.boolean()
  })
  .passthrough()

export const PieChannelListResponseSchema = z
  .object({
    items: z.array(PieChannelSchema),
    nextCursor: z.string().nullable()
  })
  .passthrough()

export const PieMessageListResponseSchema = z
  .object({
    items: z.array(PieMessageSchema),
    nextCursor: z.string().nullable()
  })
  .passthrough()

export const PieChatMessagesChangedSchema = z
  .object({
    type: z.literal('chat.messages-changed'),
    organizationId: opaqueIdSchema
  })
  .passthrough()

export const PieChatListMessagesOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: opaqueIdSchema.optional(),
    threadRoot: opaqueIdSchema.optional()
  })
  .strict()

// Extra POST-message fields. Body stays plain text; mention targets ride
// out-of-band as user ids (backend resolves + drops non-members), and
// attachmentIds link previously-uploaded objects at post time.
export const PieSendMessageOptionsSchema = z
  .object({
    threadRootMessageId: opaqueIdSchema.optional(),
    mentions: z.array(opaqueIdSchema).max(100).optional(),
    mentionChannel: z.boolean().optional(),
    mentionHere: z.boolean().optional(),
    attachmentIds: z.array(z.string()).max(10).optional()
  })
  .strict()

export const PiePinnedMessageSchema = z
  .object({
    message: PieMessageSchema,
    pinnedBy: z.string(),
    pinnedAt: z.string()
  })
  .passthrough()

export const PiePinListResponseSchema = z
  .object({ items: z.array(PiePinnedMessageSchema) })
  .passthrough()

export const PieMessageSearchResponseSchema = z
  .object({
    items: z.array(PieMessageSchema),
    nextCursor: z.string().nullable()
  })
  .passthrough()

// One org member the composer can @-mention and the sidebar can DM.
export const PieChatMemberSchema = z
  .object({
    userId: opaqueIdSchema,
    displayName: z.string()
  })
  .passthrough()

export const PieAttachmentIntentSchema = z
  .object({
    id: z.string(),
    objectId: z.string(),
    uploadUrl: z.string(),
    expiresAt: z.string()
  })
  .passthrough()

export const PieAttachmentDownloadSchema = z
  .object({
    url: z.string(),
    filename: z.string(),
    contentType: z.string(),
    expiresAt: z.string()
  })
  .passthrough()

export type ChannelVisibility = z.infer<typeof ChannelVisibilitySchema>
export type ChannelKind = z.infer<typeof ChannelKindSchema>
export type PieChannel = z.infer<typeof PieChannelSchema>
export type PieMessage = z.infer<typeof PieMessageSchema>
export type PieMessageReaction = z.infer<typeof PieMessageReactionSchema>
export type PieMessageAttachment = z.infer<typeof PieMessageAttachmentSchema>
export type PieChannelListResponse = z.infer<typeof PieChannelListResponseSchema>
export type PieMessageListResponse = z.infer<typeof PieMessageListResponseSchema>
export type PieChatMessagesChanged = z.infer<typeof PieChatMessagesChangedSchema>
export type PieChatListMessagesOptions = z.infer<typeof PieChatListMessagesOptionsSchema>
export type PieSendMessageOptions = z.infer<typeof PieSendMessageOptionsSchema>
export type PiePinnedMessage = z.infer<typeof PiePinnedMessageSchema>
export type PiePinListResponse = z.infer<typeof PiePinListResponseSchema>
export type PieMessageSearchResponse = z.infer<typeof PieMessageSearchResponseSchema>
export type PieChatMember = z.infer<typeof PieChatMemberSchema>
export type PieAttachmentIntent = z.infer<typeof PieAttachmentIntentSchema>
export type PieAttachmentDownload = z.infer<typeof PieAttachmentDownloadSchema>

// Renderer-facing bridge. It never carries tokens or the org/user ids the renderer
// should not hold — Main resolves those from the auth lifecycle + session broker.
export type PieChatRendererApi = {
  listChannels: () => Promise<PieChannel[]>
  listMessages: (
    channelId: string,
    opts?: PieChatListMessagesOptions
  ) => Promise<PieMessageListResponse>
  sendMessage: (
    channelId: string,
    body: string,
    opts?: PieSendMessageOptions
  ) => Promise<PieMessage>
  editMessage: (
    channelId: string,
    messageId: string,
    body: string,
    expectedVersion: number
  ) => Promise<PieMessage>
  deleteMessage: (channelId: string, messageId: string) => Promise<void>
  markRead: (channelId: string, lastReadMessageId: string) => Promise<void>
  addReaction: (channelId: string, messageId: string, emoji: string) => Promise<PieMessage>
  removeReaction: (channelId: string, messageId: string, emoji: string) => Promise<void>
  pinMessage: (channelId: string, messageId: string) => Promise<void>
  unpinMessage: (channelId: string, messageId: string) => Promise<void>
  listPins: (channelId: string) => Promise<PiePinnedMessage[]>
  createChannel: (name: string, visibility?: ChannelVisibility) => Promise<PieChannel>
  createDm: (otherUserId: string) => Promise<PieChannel>
  createGroupDm: (participantUserIds: string[]) => Promise<PieChannel>
  muteChannel: (channelId: string) => Promise<void>
  unmuteChannel: (channelId: string) => Promise<void>
  searchMessages: (query: string, cursor?: string) => Promise<PieMessageSearchResponse>
  listMembers: () => Promise<PieChatMember[]>
  // Uploads bytes and returns the attachment intent whose id links the file to a
  // subsequent sendMessage via opts.attachmentIds. Both the intent and the
  // presigned PUT happen in Main.
  uploadAttachment: (
    channelId: string,
    meta: { filename: string; contentType: string; byteSize: number },
    file: ArrayBuffer
  ) => Promise<PieAttachmentIntent>
  downloadAttachment: (channelId: string, attachmentId: string) => Promise<PieAttachmentDownload>
  onMessagesChanged: (callback: (event: PieChatMessagesChanged) => void) => () => void
}
