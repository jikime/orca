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
  PieChatMessagesChangedSchema
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

export type PieChatHandlerDeps = {
  // Resolved in Main so the token and org/user ids never reach the renderer.
  getApiBaseUrl: () => string | null
  getAccessToken: () => string | null
  getOrganizationId: () => string | null
  fetchImpl?: typeof fetch
}

type ResolvedAuth = { apiBaseUrl: string; accessToken: string; organizationId: string }

function resolveAuth(deps: PieChatHandlerDeps): ResolvedAuth {
  const apiBaseUrl = deps.getApiBaseUrl()
  const accessToken = deps.getAccessToken()
  const organizationId = deps.getOrganizationId()
  if (!apiBaseUrl || !accessToken || !organizationId) {
    throw new Error('PIE_CHAT_NOT_AUTHENTICATED')
  }
  return { apiBaseUrl, accessToken, organizationId }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertChannelId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('PIE_CHAT_INVALID_REQUEST')
  }
  return value
}

function assertBody(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('PIE_CHAT_INVALID_REQUEST')
  }
  return value
}

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
  const fetchImpl = deps.fetchImpl ?? fetch

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
    const payload = input as { channelId?: unknown; body?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const body = assertBody(payload?.body)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    // A fresh Idempotency-Key per send attempt: a network retry cannot duplicate.
    return sendMessage(
      apiBaseUrl,
      accessToken,
      organizationId,
      channelId,
      { body, idempotencyKey: randomUUID() },
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
}
