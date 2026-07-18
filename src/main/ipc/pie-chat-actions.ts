import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import {
  PIE_CHAT_ADD_REACTION_CHANNEL,
  PIE_CHAT_LIST_PINS_CHANNEL,
  PIE_CHAT_PIN_MESSAGE_CHANNEL,
  PIE_CHAT_REMOVE_REACTION_CHANNEL,
  PIE_CHAT_UNPIN_MESSAGE_CHANNEL
} from '../../shared/pie-chat-contract'
import {
  addReaction,
  listPins,
  pinMessage,
  removeReaction,
  unpinMessage
} from '../pie-chat/chat-message-actions-client'
import { assertTrustedPieMainFrame } from './pie-renderer-trust'
import {
  assertChannelId,
  assertNonEmptyString,
  resolveAuth,
  resolveChatFetch,
  type PieChatHandlerDeps
} from './pie-chat-ipc-shared'

// Reaction + pin IPC handlers. Split from pie-chat.ts to keep each file inside
// the size budget; wiring and trust-gating stay identical to the core handlers.
export function registerPieChatActionHandlers(deps: PieChatHandlerDeps): void {
  const fetchImpl = resolveChatFetch(deps)

  ipcMain.removeHandler(PIE_CHAT_ADD_REACTION_CHANNEL)
  ipcMain.handle(PIE_CHAT_ADD_REACTION_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown; messageId?: unknown; emoji?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const messageId = assertChannelId(payload?.messageId)
    const emoji = assertNonEmptyString(payload?.emoji)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return addReaction(
      apiBaseUrl,
      accessToken,
      organizationId,
      channelId,
      messageId,
      { emoji, idempotencyKey: randomUUID() },
      fetchImpl
    )
  })

  ipcMain.removeHandler(PIE_CHAT_REMOVE_REACTION_CHANNEL)
  ipcMain.handle(PIE_CHAT_REMOVE_REACTION_CHANNEL, async (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown; messageId?: unknown; emoji?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const messageId = assertChannelId(payload?.messageId)
    const emoji = assertNonEmptyString(payload?.emoji)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    await removeReaction(
      apiBaseUrl,
      accessToken,
      organizationId,
      channelId,
      messageId,
      emoji,
      fetchImpl
    )
  })

  ipcMain.removeHandler(PIE_CHAT_PIN_MESSAGE_CHANNEL)
  ipcMain.handle(PIE_CHAT_PIN_MESSAGE_CHANNEL, async (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown; messageId?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const messageId = assertChannelId(payload?.messageId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    await pinMessage(apiBaseUrl, accessToken, organizationId, channelId, messageId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_UNPIN_MESSAGE_CHANNEL)
  ipcMain.handle(PIE_CHAT_UNPIN_MESSAGE_CHANNEL, async (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown; messageId?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const messageId = assertChannelId(payload?.messageId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    await unpinMessage(apiBaseUrl, accessToken, organizationId, channelId, messageId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_LIST_PINS_CHANNEL)
  ipcMain.handle(PIE_CHAT_LIST_PINS_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return listPins(apiBaseUrl, accessToken, organizationId, channelId, fetchImpl)
  })
}
