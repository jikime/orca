import { ipcMain } from 'electron'
import {
  PIE_CHAT_LIST_NOTIFICATIONS_CHANNEL,
  PIE_CHAT_MARK_ALL_NOTIFICATIONS_READ_CHANNEL,
  PIE_CHAT_MARK_NOTIFICATION_READ_CHANNEL
} from '../../shared/pie-chat-contract'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead
} from '../pie-chat/chat-notification-client'
import { assertTrustedPieMainFrame } from './pie-renderer-trust'
import {
  assertChannelId,
  resolveAuth,
  resolveChatFetch,
  type PieChatHandlerDeps
} from './pie-chat-ipc-shared'

// The caller's own durable notification feed. Split from pie-chat.ts to keep each
// file inside the size budget; wiring + trust-gating match the core handlers, and
// resolveChatFetch gives every call the shared 401 auto-refresh retry.
export function registerPieChatNotificationHandlers(deps: PieChatHandlerDeps): void {
  const fetchImpl = resolveChatFetch(deps)

  ipcMain.removeHandler(PIE_CHAT_LIST_NOTIFICATIONS_CHANNEL)
  ipcMain.handle(PIE_CHAT_LIST_NOTIFICATIONS_CHANNEL, (event) => {
    assertTrustedPieMainFrame(event)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return listNotifications(apiBaseUrl, accessToken, organizationId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_MARK_NOTIFICATION_READ_CHANNEL)
  ipcMain.handle(PIE_CHAT_MARK_NOTIFICATION_READ_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const notificationId = assertChannelId((input as { notificationId?: unknown })?.notificationId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return markNotificationRead(apiBaseUrl, accessToken, organizationId, notificationId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_MARK_ALL_NOTIFICATIONS_READ_CHANNEL)
  ipcMain.handle(PIE_CHAT_MARK_ALL_NOTIFICATIONS_READ_CHANNEL, (event) => {
    assertTrustedPieMainFrame(event)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return markAllNotificationsRead(apiBaseUrl, accessToken, organizationId, fetchImpl)
  })
}
