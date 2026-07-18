import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import {
  PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL,
  PIE_CHAT_DOWNLOAD_ATTACHMENT_CHANNEL,
  PIE_CHAT_SEARCH_MESSAGES_CHANNEL
} from '../../shared/pie-chat-contract'
import {
  createAttachmentIntent,
  downloadAttachment,
  searchMessages,
  uploadAttachment
} from '../pie-chat/chat-search-attachment-client'
import { assertTrustedPieMainFrame } from './pie-renderer-trust'
import {
  assertChannelId,
  assertNonEmptyString,
  resolveAuth,
  resolveChatFetch,
  type PieChatHandlerDeps
} from './pie-chat-ipc-shared'

// Search + attachment IPC. The intent create returns a presigned upload URL; the
// renderer streams the bytes back through PIE_CHAT_CREATE_ATTACHMENT_INTENT then
// this handler PUTs to object storage in Main (renderer never touches the token,
// and the PUT avoids renderer CSP restrictions on the storage host).
export function registerPieChatSearchAttachmentHandlers(deps: PieChatHandlerDeps): void {
  const fetchImpl = resolveChatFetch(deps)

  ipcMain.removeHandler(PIE_CHAT_SEARCH_MESSAGES_CHANNEL)
  ipcMain.handle(PIE_CHAT_SEARCH_MESSAGES_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { query?: unknown; cursor?: unknown }
    const query = assertNonEmptyString(payload?.query)
    const cursor = payload?.cursor === undefined ? undefined : assertChannelId(payload.cursor)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return searchMessages(apiBaseUrl, accessToken, organizationId, { query, cursor }, fetchImpl)
  })

  ipcMain.removeHandler(PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL)
  ipcMain.handle(PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL, async (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as {
      channelId?: unknown
      filename?: unknown
      contentType?: unknown
      byteSize?: unknown
      file?: unknown
    }
    const channelId = assertChannelId(payload?.channelId)
    const filename = assertNonEmptyString(payload?.filename)
    const contentType = assertNonEmptyString(payload?.contentType)
    if (typeof payload?.byteSize !== 'number' || !Number.isInteger(payload.byteSize)) {
      throw new Error('PIE_CHAT_INVALID_REQUEST')
    }
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    const intent = await createAttachmentIntent(
      apiBaseUrl,
      accessToken,
      organizationId,
      channelId,
      { filename, contentType, byteSize: payload.byteSize, idempotencyKey: randomUUID() },
      fetchImpl
    )
    // Optional inline upload: when the renderer passes the bytes, PUT them now so
    // the caller gets an attachment id ready to reference in the message body.
    if (payload?.file instanceof ArrayBuffer || ArrayBuffer.isView(payload?.file)) {
      const buffer = payload.file instanceof ArrayBuffer ? payload.file : payload.file.buffer
      await uploadAttachment(intent.uploadUrl, buffer as ArrayBuffer, contentType, fetchImpl)
    }
    return intent
  })

  ipcMain.removeHandler(PIE_CHAT_DOWNLOAD_ATTACHMENT_CHANNEL)
  ipcMain.handle(PIE_CHAT_DOWNLOAD_ATTACHMENT_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const payload = input as { channelId?: unknown; attachmentId?: unknown }
    const channelId = assertChannelId(payload?.channelId)
    const attachmentId = assertNonEmptyString(payload?.attachmentId)
    const { apiBaseUrl, accessToken, organizationId } = resolveAuth(deps)
    return downloadAttachment(
      apiBaseUrl,
      accessToken,
      organizationId,
      channelId,
      attachmentId,
      fetchImpl
    )
  })
}
