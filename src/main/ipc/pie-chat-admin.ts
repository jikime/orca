import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import {
  ChannelVisibilitySchema,
  PIE_CHAT_CREATE_CHANNEL_CHANNEL,
  PIE_CHAT_CREATE_DM_CHANNEL,
  PIE_CHAT_CREATE_GROUP_DM_CHANNEL,
  PIE_CHAT_LIST_MEMBERS_CHANNEL,
  PIE_CHAT_MUTE_CHANNEL_CHANNEL,
  PIE_CHAT_UNMUTE_CHANNEL_CHANNEL
} from '../../shared/pie-chat-contract'
import {
  createChannel,
  createDm,
  createGroupDm,
  listMembers,
  muteChannel,
  unmuteChannel
} from '../pie-chat/chat-channel-admin-client'
import { assertTrustedPieMainFrame } from './pie-renderer-trust'
import {
  assertChannelId,
  assertNonEmptyString,
  resolveAuth,
  resolveChatFetch,
  type PieChatHandlerDeps
} from './pie-chat-ipc-shared'

// Channel/DM creation, mute toggle, and the member roster. Split from pie-chat.ts
// to keep each file inside the size budget.
export function registerPieChatAdminHandlers(deps: PieChatHandlerDeps): void {
  const fetchImpl = resolveChatFetch(deps)

  ipcMain.removeHandler(PIE_CHAT_CREATE_CHANNEL_CHANNEL)
  ipcMain.handle(PIE_CHAT_CREATE_CHANNEL_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { name?: unknown; visibility?: unknown }
    const name = assertNonEmptyString(payload?.name)
    const visibility =
      payload?.visibility === undefined
        ? undefined
        : ChannelVisibilitySchema.parse(payload.visibility)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return createChannel(
      apiBaseUrl,
      accessToken,
      organizationId,
      { name, visibility, idempotencyKey: randomUUID() },
      fetchImpl
    )
  })

  ipcMain.removeHandler(PIE_CHAT_CREATE_DM_CHANNEL)
  ipcMain.handle(PIE_CHAT_CREATE_DM_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { otherUserId?: unknown }
    const otherUserId = assertChannelId(payload?.otherUserId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return createDm(apiBaseUrl, accessToken, organizationId, otherUserId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_CREATE_GROUP_DM_CHANNEL)
  ipcMain.handle(PIE_CHAT_CREATE_GROUP_DM_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { participantUserIds?: unknown }
    if (!Array.isArray(payload?.participantUserIds)) {
      throw new Error('PIE_CHAT_INVALID_REQUEST')
    }
    const participantUserIds = payload.participantUserIds.map((id) => assertChannelId(id))
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return createGroupDm(apiBaseUrl, accessToken, organizationId, participantUserIds, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_MUTE_CHANNEL_CHANNEL)
  ipcMain.handle(PIE_CHAT_MUTE_CHANNEL_CHANNEL, async (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const channelId = assertChannelId((input as { channelId?: unknown })?.channelId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    await muteChannel(apiBaseUrl, accessToken, organizationId, channelId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_UNMUTE_CHANNEL_CHANNEL)
  ipcMain.handle(PIE_CHAT_UNMUTE_CHANNEL_CHANNEL, async (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const channelId = assertChannelId((input as { channelId?: unknown })?.channelId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    await unmuteChannel(apiBaseUrl, accessToken, organizationId, channelId, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_LIST_MEMBERS_CHANNEL)
  ipcMain.handle(PIE_CHAT_LIST_MEMBERS_CHANNEL, (event) => {
    assertTrustedPieMainFrame(event)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return listMembers(apiBaseUrl, accessToken, organizationId, fetchImpl)
  })
}
