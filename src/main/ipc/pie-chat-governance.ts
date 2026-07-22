import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import {
  PIE_CHAT_APPLY_CHANNEL_RETENTION_CHANNEL,
  PIE_CHAT_EXPORT_CHANNEL_CHANNEL,
  PIE_CHAT_LIST_CHANNEL_AUDIT_CHANNEL
} from '../../shared/pie-chat-ipc-channels'
import {
  applyChannelRetention,
  exportChannel,
  listChannelAudit
} from '../pie-chat/chat-channel-governance-client'
import { assertTrustedPieMainFrame } from './pie-renderer-trust'
import {
  assertChannelId,
  resolveAuth,
  resolveChatFetch,
  type PieChatHandlerDeps
} from './pie-chat-ipc-shared'

export function registerPieChatGovernanceHandlers(deps: PieChatHandlerDeps): void {
  const fetchImpl = resolveChatFetch(deps)
  ipcMain.removeHandler(PIE_CHAT_LIST_CHANNEL_AUDIT_CHANNEL)
  ipcMain.handle(PIE_CHAT_LIST_CHANNEL_AUDIT_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const channelId = assertChannelId((input as { channelId?: unknown })?.channelId)
    const auth = resolveAuth(deps)
    return listChannelAudit(
      auth.apiBaseUrl,
      auth.accessToken,
      auth.organizationId,
      channelId,
      fetchImpl
    )
  })

  ipcMain.removeHandler(PIE_CHAT_EXPORT_CHANNEL_CHANNEL)
  ipcMain.handle(PIE_CHAT_EXPORT_CHANNEL_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const channelId = assertChannelId((input as { channelId?: unknown })?.channelId)
    const auth = resolveAuth(deps)
    return exportChannel(
      auth.apiBaseUrl,
      auth.accessToken,
      auth.organizationId,
      channelId,
      fetchImpl
    )
  })

  ipcMain.removeHandler(PIE_CHAT_APPLY_CHANNEL_RETENTION_CHANNEL)
  ipcMain.handle(PIE_CHAT_APPLY_CHANNEL_RETENTION_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const channelId = assertChannelId((input as { channelId?: unknown })?.channelId)
    const auth = resolveAuth(deps)
    return applyChannelRetention(
      auth.apiBaseUrl,
      auth.accessToken,
      auth.organizationId,
      channelId,
      { idempotencyKey: randomUUID() },
      fetchImpl
    )
  })
}
