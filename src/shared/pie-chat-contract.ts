import { z } from 'zod'

export {
  PieChannelNotificationLevelSchema,
  PieChatNotificationClickedSchema,
  PieNotificationListResponseSchema,
  PieNotificationPreferencesSchema,
  PieNotificationPreferencesUpdateSchema,
  PieNotificationsReadAllResponseSchema,
  PieNotificationSchema
} from './pie-chat-notification-contract'
export type {
  PieChannelNotificationLevel,
  PieChatNotificationClicked,
  PieNotification,
  PieNotificationListResponse,
  PieNotificationPreferences,
  PieNotificationPreferencesUpdate
} from './pie-chat-notification-contract'

// IPC channel names live in a zod-free module so the sandboxed preload can import
// them without pulling zod. Re-exported here for existing Main-side importers.
export {
  PIE_CHAT_ADD_REACTION_CHANNEL,
  PIE_CHAT_ADD_CHANNEL_MEMBER_CHANNEL,
  PIE_CHAT_UPDATE_CHANNEL_CHANNEL,
  PIE_CHAT_LIST_CHANNEL_MEMBERS_CHANNEL,
  PIE_CHAT_REMOVE_CHANNEL_MEMBER_CHANNEL,
  PIE_CHAT_GET_MESSAGE_CHANNEL,
  PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL,
  PIE_CHAT_CREATE_CHANNEL_CHANNEL,
  PIE_CHAT_CREATE_DM_CHANNEL,
  PIE_CHAT_CREATE_GROUP_DM_CHANNEL,
  PIE_CHAT_DELETE_MESSAGE_CHANNEL,
  PIE_CHAT_DOWNLOAD_ATTACHMENT_CHANNEL,
  PIE_CHAT_EDIT_MESSAGE_CHANNEL,
  PIE_CHAT_GET_PRESENCE_CHANNEL,
  PIE_CHAT_LIST_CHANNELS_CHANNEL,
  PIE_CHAT_LIST_MEMBERS_CHANNEL,
  PIE_CHAT_LIST_MESSAGES_CHANNEL,
  PIE_CHAT_LIST_NOTIFICATIONS_CHANNEL,
  PIE_CHAT_LIST_PINS_CHANNEL,
  PIE_CHAT_MARK_ALL_NOTIFICATIONS_READ_CHANNEL,
  PIE_CHAT_MARK_NOTIFICATION_READ_CHANNEL,
  PIE_CHAT_GET_NOTIFICATION_PREFERENCES_CHANNEL,
  PIE_CHAT_UPDATE_NOTIFICATION_PREFERENCES_CHANNEL,
  PIE_CHAT_SET_CHANNEL_NOTIFICATION_LEVEL_CHANNEL,
  PIE_CHAT_NOTIFICATION_CLICKED_CHANNEL,
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
  PIE_CHAT_UNPIN_MESSAGE_CHANNEL
} from './pie-chat-ipc-channels'

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
    topic: z.string().max(250),
    description: z.string().max(2000),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    version: z.number().int(),
    archivedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    // Unread messages for the requesting user; present only on the channel list.
    unreadCount: z.number().int().optional(),
    lastReadMessageId: opaqueIdSchema.nullable().optional()
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

// Ephemeral collaboration pushes forwarded from the realtime connection to the
// trusted renderer. Non-durable: the payload IS the state (typing self-clears on
// a TTL, presence on the next presence event); they carry no cursor/version.
export const PieChatTypingChangedSchema = z
  .object({
    type: z.literal('chat.typing-changed'),
    organizationId: opaqueIdSchema,
    channelId: opaqueIdSchema,
    userId: opaqueIdSchema,
    at: z.string()
  })
  .passthrough()

export const PieChatPresenceChangedSchema = z
  .object({
    type: z.literal('chat.presence-changed'),
    organizationId: opaqueIdSchema,
    userId: opaqueIdSchema,
    state: z.enum(['online', 'offline']),
    at: z.string()
  })
  .passthrough()

export const PieChatListMessagesOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: opaqueIdSchema.optional(),
    // `before` pages toward older history. `latest` opens the newest page instead
    // of the legacy oldest-first page used by forward cursor consumers.
    before: opaqueIdSchema.optional(),
    latest: z.boolean().optional(),
    threadRoot: opaqueIdSchema.optional()
  })
  .strict()
  .refine((options) => !(options.cursor && options.before), {
    message: 'cursor and before cannot be combined'
  })
  .refine((options) => !(options.cursor && options.latest), {
    message: 'cursor and latest cannot be combined'
  })

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

export const PieChannelMemberSchema = z
  .object({
    userId: opaqueIdSchema,
    role: z.enum(['owner', 'member']),
    addedAt: z.string()
  })
  .passthrough()

export const PieChannelUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    topic: z.string().max(250).optional(),
    description: z.string().max(2000).optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    archived: z.boolean().optional()
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: 'channel update is empty' })

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

export const PieChannelAuditEntrySchema = z
  .object({
    id: opaqueIdSchema,
    actorId: opaqueIdSchema.nullable(),
    action: z.string(),
    targetType: z.string(),
    targetId: opaqueIdSchema.nullable(),
    reason: z.string().nullable(),
    occurredAt: z.string()
  })
  .passthrough()

export const PieChannelExportSchema = z
  .object({
    exportedAt: z.string(),
    truncated: z.boolean(),
    messages: z.array(
      z
        .object({
          id: opaqueIdSchema,
          authorId: opaqueIdSchema,
          body: z.string(),
          threadRootMessageId: opaqueIdSchema.nullable(),
          createdAt: z.string(),
          editedAt: z.string(),
          deletedAt: z.string().nullable(),
          deletedBy: opaqueIdSchema.nullable(),
          deletionReason: z.string().nullable()
        })
        .passthrough()
    )
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
export type PieChatTypingChanged = z.infer<typeof PieChatTypingChangedSchema>
export type PieChatPresenceChanged = z.infer<typeof PieChatPresenceChangedSchema>
export type PieChatListMessagesOptions = z.infer<typeof PieChatListMessagesOptionsSchema>
export type PieSendMessageOptions = z.infer<typeof PieSendMessageOptionsSchema>
export type PiePinnedMessage = z.infer<typeof PiePinnedMessageSchema>
export type PiePinListResponse = z.infer<typeof PiePinListResponseSchema>
export type PieMessageSearchResponse = z.infer<typeof PieMessageSearchResponseSchema>
export type PieChatMember = z.infer<typeof PieChatMemberSchema>
export type PieChannelMember = z.infer<typeof PieChannelMemberSchema>
export type PieChannelUpdate = z.infer<typeof PieChannelUpdateSchema>
export type PieAttachmentIntent = z.infer<typeof PieAttachmentIntentSchema>
export type PieAttachmentDownload = z.infer<typeof PieAttachmentDownloadSchema>
export type PieChannelAuditEntry = z.infer<typeof PieChannelAuditEntrySchema>
export type PieChannelExport = z.infer<typeof PieChannelExportSchema>
export type { PieChatRendererApi } from './pie-chat-renderer-api'
