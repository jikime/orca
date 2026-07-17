import { z } from 'zod'

// IPC channel names for the Pie collaboration chat surface. Invoke channels are
// request/response; the changed channel is a Main->renderer push nudge.
export const PIE_CHAT_LIST_CHANNELS_CHANNEL = 'pie:chat:list-channels'
export const PIE_CHAT_LIST_MESSAGES_CHANNEL = 'pie:chat:list-messages'
export const PIE_CHAT_SEND_MESSAGE_CHANNEL = 'pie:chat:send-message'
export const PIE_CHAT_EDIT_MESSAGE_CHANNEL = 'pie:chat:edit-message'
export const PIE_CHAT_DELETE_MESSAGE_CHANNEL = 'pie:chat:delete-message'
export const PIE_CHAT_MARK_READ_CHANNEL = 'pie:chat:mark-read'
export const PIE_CHAT_MESSAGES_CHANGED_CHANNEL = 'pie:chat:messages-changed'

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

// Renderer-facing bridge. It never carries tokens or the org/user ids the renderer
// should not hold — Main resolves those from the auth lifecycle + session broker.
export type PieChatRendererApi = {
  listChannels: () => Promise<PieChannel[]>
  listMessages: (
    channelId: string,
    opts?: PieChatListMessagesOptions
  ) => Promise<PieMessageListResponse>
  sendMessage: (channelId: string, body: string) => Promise<PieMessage>
  editMessage: (
    channelId: string,
    messageId: string,
    body: string,
    expectedVersion: number
  ) => Promise<PieMessage>
  deleteMessage: (channelId: string, messageId: string) => Promise<void>
  markRead: (channelId: string, lastReadMessageId: string) => Promise<void>
  onMessagesChanged: (callback: (event: PieChatMessagesChanged) => void) => () => void
}
