import { randomUUID } from 'node:crypto'
import { ipcMain, webContents } from 'electron'
import {
  PIE_CHAT_DELETE_MESSAGE_CHANNEL,
  PIE_CHAT_EDIT_MESSAGE_CHANNEL,
  PIE_CHAT_LIST_CHANNELS_CHANNEL,
  PIE_CHAT_LIST_MESSAGES_CHANNEL,
  PIE_CHAT_MARK_READ_CHANNEL,
  PIE_CHAT_MESSAGES_CHANGED_CHANNEL,
  PIE_CHAT_SEND_MESSAGE_CHANNEL,
  PieChatListMessagesOptionsSchema,
  PieChatMessagesChangedSchema,
  PieSendMessageOptionsSchema
} from '../../shared/pie-chat-contract'
import {
  deleteMessage,
  editMessage,
  listChannels,
  listMessages,
  markRead,
  sendMessage
} from '../pie-chat/chat-control-plane-client'
import { assertTrustedPieMainFrame, getTrustedPieRendererWebContentsId } from './pie-renderer-trust'
import {
  assertBody,
  assertChannelId,
  resolveAuth,
  resolveChatFetch,
  type PieChatHandlerDeps
} from './pie-chat-ipc-shared'
import { registerPieChatActionHandlers } from './pie-chat-actions'
import { registerPieChatAdminHandlers } from './pie-chat-admin'
import { registerPieChatNotificationHandlers } from './pie-chat-notifications'
import { registerPieChatSearchAttachmentHandlers } from './pie-chat-search-attachments'

export type { PieChatHandlerDeps } from './pie-chat-ipc-shared'

/** Nudges the trusted renderer to refetch the active channel. Mirrors the
 *  pie-session change fan-out (only the current trusted renderer receives it). */
export function emitPieChatMessagesChanged(organizationId: string): void {
  const trustedId = getTrustedPieRendererWebContentsId()
  if (trustedId === null) {
    return
  }
  const renderer = webContents.fromId(trustedId)
  if (!renderer || renderer.isDestroyed()) {
    return
  }
  renderer.send(
    PIE_CHAT_MESSAGES_CHANGED_CHANNEL,
    PieChatMessagesChangedSchema.parse({ type: 'chat.messages-changed', organizationId })
  )
}

export function registerPieChatHandlers(deps: PieChatHandlerDeps): void {
  const fetchImpl = resolveChatFetch(deps)

  ipcMain.removeHandler(PIE_CHAT_LIST_CHANNELS_CHANNEL)
  ipcMain.handle(PIE_CHAT_LIST_CHANNELS_CHANNEL, (event) => {
    assertTrustedPieMainFrame(event)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return listChannels(apiBaseUrl, accessToken, organizationId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_LIST_MESSAGES_CHANNEL)
  ipcMain.handle(PIE_CHAT_LIST_MESSAGES_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown; opts?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const opts = PieChatListMessagesOptionsSchema.parse(payload?.opts ?? {})
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return listMessages(apiBaseUrl, accessToken, organizationId, channelId, opts, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_SEND_MESSAGE_CHANNEL)
  ipcMain.handle(PIE_CHAT_SEND_MESSAGE_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown; body?: unknown; opts?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const body = assertBody(payload?.body)
    const opts =
      payload?.opts === undefined ? undefined : PieSendMessageOptionsSchema.parse(payload.opts)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    // A fresh Idempotency-Key per send attempt: a network retry cannot duplicate.
    return sendMessage(
      apiBaseUrl,
      accessToken,
      organizationId,
      channelId,
      { body, idempotencyKey: randomUUID(), opts },
      fetchImpl
    )
  })

  ipcMain.removeHandler(PIE_CHAT_EDIT_MESSAGE_CHANNEL)
  ipcMain.handle(PIE_CHAT_EDIT_MESSAGE_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as {
      channelId?: unknown
      messageId?: unknown
      body?: unknown
      expectedVersion?: unknown
    }
    const channelId = assertChannelId(payload?.channelId)
    const messageId = assertChannelId(payload?.messageId)
    const body = assertBody(payload?.body)
    if (
      typeof payload?.expectedVersion !== 'number' ||
      !Number.isInteger(payload.expectedVersion)
    ) {
      throw new Error('PIE_CHAT_INVALID_REQUEST')
    }
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return editMessage(
      apiBaseUrl,
      accessToken,
      organizationId,
      channelId,
      messageId,
      { body, expectedVersion: payload.expectedVersion },
      fetchImpl
    )
  })

  ipcMain.removeHandler(PIE_CHAT_DELETE_MESSAGE_CHANNEL)
  ipcMain.handle(PIE_CHAT_DELETE_MESSAGE_CHANNEL, async (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown; messageId?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const messageId = assertChannelId(payload?.messageId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    await deleteMessage(apiBaseUrl, accessToken, organizationId, channelId, messageId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_MARK_READ_CHANNEL)
  ipcMain.handle(PIE_CHAT_MARK_READ_CHANNEL, async (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown; lastReadMessageId?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const lastReadMessageId = assertChannelId(payload?.lastReadMessageId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    await markRead(
      apiBaseUrl,
      accessToken,
      organizationId,
      channelId,
      { lastReadMessageId, idempotencyKey: randomUUID() },
      fetchImpl
    )
  })

  registerPieChatActionHandlers(deps)
  registerPieChatAdminHandlers(deps)
  registerPieChatNotificationHandlers(deps)
  registerPieChatSearchAttachmentHandlers(deps)
}
