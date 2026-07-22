import { randomUUID } from 'node:crypto'
import { ipcMain, webContents } from 'electron'
import {
  PIE_CHAT_DELETE_MESSAGE_CHANNEL,
  PIE_CHAT_EDIT_MESSAGE_CHANNEL,
  PIE_CHAT_LIST_CHANNELS_CHANNEL,
  PIE_CHAT_GET_MESSAGE_CHANNEL,
  PIE_CHAT_GET_PRESENCE_CHANNEL,
  PIE_CHAT_LIST_MESSAGES_CHANNEL,
  PIE_CHAT_MARK_READ_CHANNEL,
  PIE_CHAT_MESSAGES_CHANGED_CHANNEL,
  PIE_CHAT_PRESENCE_CHANGED_CHANNEL,
  PIE_CHAT_SEND_MESSAGE_CHANNEL,
  PIE_CHAT_SEND_TYPING_CHANNEL,
  PIE_CHAT_TYPING_CHANGED_CHANNEL,
  PieChatListMessagesOptionsSchema,
  PieChatMessagesChangedSchema,
  PieChatPresenceChangedSchema,
  PieChatTypingChangedSchema,
  PieSendMessageOptionsSchema,
  type PieChatPresenceChanged,
  type PieChatTypingChanged
} from '../../shared/pie-chat-contract'
import {
  deleteMessage,
  editMessage,
  getMessage,
  listChannels,
  listMessages,
  markRead,
  sendMessage,
  sendTyping
} from '../pie-chat/chat-control-plane-client'
import { assertTrustedPieMainFrame, getTrustedPieRendererWebContentsId } from './pie-renderer-trust'
import {
  assertBody,
  assertChannelId,
  assertClientRequestId,
  assertNonEmptyString,
  resolveAuth,
  resolveChatFetch,
  type PieChatHandlerDeps
} from './pie-chat-ipc-shared'
import { registerPieChatActionHandlers } from './pie-chat-actions'
import { registerPieChatAdminHandlers } from './pie-chat-admin'
import { registerPieChatNotificationHandlers } from './pie-chat-notifications'
import { registerPieChatSearchAttachmentHandlers } from './pie-chat-search-attachments'
import { registerPieChatGovernanceHandlers } from './pie-chat-governance'

export type { PieChatHandlerDeps } from './pie-chat-ipc-shared'

/** Resolves the trusted chat renderer, or null when none is registered/alive.
 *  Every chat push targets only this one renderer (mirrors the pie-session fan-out). */
function trustedChatRenderer(): Electron.WebContents | null {
  const trustedId = getTrustedPieRendererWebContentsId()
  if (trustedId === null) {
    return null
  }
  const renderer = webContents.fromId(trustedId)
  return !renderer || renderer.isDestroyed() ? null : renderer
}

const MESSAGE_CHANGE_BATCH_MS = 50
const pendingMessageChanges = new Map<string, ReturnType<typeof setTimeout>>()

/** Nudges the trusted renderer to refetch the active channel. */
export function emitPieChatMessagesChanged(organizationId: string): void {
  if (pendingMessageChanges.has(organizationId)) {
    return
  }
  // Why: reconnect catch-up can replay many chat changes at once; one renderer
  // nudge per burst avoids a parallel REST request storm without losing state.
  const timer = setTimeout(() => {
    pendingMessageChanges.delete(organizationId)
    trustedChatRenderer()?.send(
      PIE_CHAT_MESSAGES_CHANGED_CHANNEL,
      PieChatMessagesChangedSchema.parse({ type: 'chat.messages-changed', organizationId })
    )
  }, MESSAGE_CHANGE_BATCH_MS)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
  pendingMessageChanges.set(organizationId, timer)
}

/** Forwards an ephemeral typing signal to the trusted renderer only. */
export function emitPieChatTypingChanged(input: {
  organizationId: string
  channelId: string
  userId: string
  at: string
}): void {
  const payload: PieChatTypingChanged = PieChatTypingChangedSchema.parse({
    type: 'chat.typing-changed',
    ...input
  })
  trustedChatRenderer()?.send(PIE_CHAT_TYPING_CHANGED_CHANNEL, payload)
}

// The current online set, kept in Main so a renderer that mounts AFTER the initial
// presence burst (IPC is not buffered per-listener) can seed itself on demand
// rather than showing everyone offline until the next transition.
const onlinePresence = new Set<string>()

export function getOnlinePresenceUserIds(): string[] {
  return [...onlinePresence]
}

/** Forwards an ephemeral presence change to the trusted renderer only. */
export function emitPieChatPresenceChanged(input: {
  organizationId: string
  userId: string
  state: 'online' | 'offline'
  at: string
}): void {
  if (input.state === 'online') {
    onlinePresence.add(input.userId)
  } else {
    onlinePresence.delete(input.userId)
  }
  const payload: PieChatPresenceChanged = PieChatPresenceChangedSchema.parse({
    type: 'chat.presence-changed',
    ...input
  })
  trustedChatRenderer()?.send(PIE_CHAT_PRESENCE_CHANGED_CHANNEL, payload)
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

  ipcMain.removeHandler(PIE_CHAT_GET_MESSAGE_CHANNEL)
  ipcMain.handle(PIE_CHAT_GET_MESSAGE_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown; messageId?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const messageId = assertChannelId(payload?.messageId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return getMessage(apiBaseUrl, accessToken, organizationId, channelId, messageId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_SEND_MESSAGE_CHANNEL)
  ipcMain.handle(PIE_CHAT_SEND_MESSAGE_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as {
      channelId?: unknown
      body?: unknown
      opts?: unknown
      clientRequestId?: unknown
    }
    const channelId = assertChannelId(payload?.channelId)
    const opts =
      payload?.opts === undefined ? undefined : PieSendMessageOptionsSchema.parse(payload.opts)
    // Why: the message contract permits an empty caption only when at least one
    // already-uploaded attachment is linked by the same send.
    const body = assertBody(payload?.body, (opts?.attachmentIds?.length ?? 0) > 0)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    // Why: the renderer reuses this UUID for an explicit retry after an ambiguous failure.
    const idempotencyKey =
      payload.clientRequestId === undefined
        ? randomUUID()
        : assertClientRequestId(payload.clientRequestId)
    return sendMessage(
      apiBaseUrl,
      accessToken,
      organizationId,
      channelId,
      { body, idempotencyKey, opts },
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
    const payload = input as { channelId?: unknown; messageId?: unknown; reason?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const messageId = assertChannelId(payload?.messageId)
    const reason =
      payload?.reason === undefined ? undefined : assertNonEmptyString(payload.reason).trim()
    if (reason !== undefined && (reason.length === 0 || reason.length > 500)) {
      throw new Error('PIE_CHAT_INVALID_REQUEST')
    }
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    await deleteMessage(
      apiBaseUrl,
      accessToken,
      organizationId,
      channelId,
      messageId,
      reason,
      fetchImpl
    )
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

  ipcMain.removeHandler(PIE_CHAT_SEND_TYPING_CHANNEL)
  ipcMain.handle(PIE_CHAT_SEND_TYPING_CHANNEL, async (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const channelId = assertChannelId((input as { channelId?: unknown })?.channelId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    await sendTyping(apiBaseUrl, accessToken, organizationId, channelId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_GET_PRESENCE_CHANNEL)
  ipcMain.handle(PIE_CHAT_GET_PRESENCE_CHANNEL, (event) => {
    assertTrustedPieMainFrame(event)
    // Seeds a just-mounted renderer with who is already online (the live
    // subscription then keeps it current); no server round-trip needed.
    return getOnlinePresenceUserIds()
  })

  registerPieChatActionHandlers(deps)
  registerPieChatAdminHandlers(deps)
  registerPieChatNotificationHandlers(deps)
  registerPieChatSearchAttachmentHandlers(deps)
  registerPieChatGovernanceHandlers(deps)
}
