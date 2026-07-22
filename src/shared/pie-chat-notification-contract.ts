import { z } from 'zod'

const opaqueIdSchema = z.string().uuid()

// Notification resources are kept separate from the timeline contract because
// desktop delivery and DND settings evolve independently from message payloads.
export const PieNotificationSchema = z
  .object({
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    userId: opaqueIdSchema,
    type: z.string(),
    channelId: z.string().nullable(),
    messageId: z.string().nullable(),
    seen: z.boolean(),
    read: z.boolean(),
    createdAt: z.string()
  })
  .passthrough()

export const PieNotificationListResponseSchema = z
  .object({
    items: z.array(PieNotificationSchema),
    nextCursor: z.string().nullable()
  })
  .passthrough()

export const PieNotificationsReadAllResponseSchema = z
  .object({ updated: z.number().int() })
  .passthrough()

export const PieChannelNotificationLevelSchema = z.enum(['all', 'mentions', 'none'])

export const PieNotificationPreferencesSchema = z
  .object({
    desktopEnabled: z.boolean(),
    dndEnabled: z.boolean(),
    dndStartMinute: z.number().int().min(0).max(1439),
    dndEndMinute: z.number().int().min(0).max(1439),
    timezone: z.string().min(1).max(100),
    channelLevels: z.array(
      z.object({ channelId: opaqueIdSchema, level: PieChannelNotificationLevelSchema })
    )
  })
  .passthrough()

export const PieNotificationPreferencesUpdateSchema = z
  .object({
    desktopEnabled: z.boolean().optional(),
    dndEnabled: z.boolean().optional(),
    dndStartMinute: z.number().int().min(0).max(1439).optional(),
    dndEndMinute: z.number().int().min(0).max(1439).optional(),
    timezone: z.string().min(1).max(100).optional()
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: 'preferences update is empty' })

export const PieChatNotificationClickedSchema = z
  .object({
    channelId: opaqueIdSchema,
    messageId: opaqueIdSchema
  })
  .strict()

export type PieNotification = z.infer<typeof PieNotificationSchema>
export type PieNotificationListResponse = z.infer<typeof PieNotificationListResponseSchema>
export type PieChannelNotificationLevel = z.infer<typeof PieChannelNotificationLevelSchema>
export type PieNotificationPreferences = z.infer<typeof PieNotificationPreferencesSchema>
export type PieNotificationPreferencesUpdate = z.infer<
  typeof PieNotificationPreferencesUpdateSchema
>
export type PieChatNotificationClicked = z.infer<typeof PieChatNotificationClickedSchema>
