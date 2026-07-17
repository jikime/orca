import {
  PieAttachmentDownloadSchema,
  PieAttachmentIntentSchema,
  PieMessageSearchResponseSchema,
  type PieAttachmentDownload,
  type PieAttachmentIntent,
  type PieMessageSearchResponse
} from '../../shared/pie-chat-contract'
import {
  authHeaders,
  channelsBase,
  jsonHeaders,
  orgBase,
  PieChatError
} from './chat-control-plane-http'

// Message search and the attachment upload/download flow. Upload is a two-step
// dance: create an intent (presigned PUT), PUT the bytes to object storage, then
// reference the intent id via attachmentIds when posting the message.

export async function searchMessages(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  input: { query: string; cursor?: string; limit?: number },
  fetchImpl: typeof fetch = fetch
): Promise<PieMessageSearchResponse> {
  const query = new URLSearchParams({ q: input.query })
  if (input.cursor) {
    query.set('cursor', input.cursor)
  }
  if (input.limit !== undefined) {
    query.set('limit', String(input.limit))
  }
  const response = await fetchImpl(
    `${orgBase(apiBaseUrl, organizationId)}/messages/search?${query.toString()}`,
    { headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`search messages failed with ${response.status}`, response.status)
  }
  const parsed = PieMessageSearchResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('search response failed schema validation')
  }
  return parsed.data
}

export async function createAttachmentIntent(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  input: { filename: string; contentType: string; byteSize: number; idempotencyKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<PieAttachmentIntent> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/attachments/intents`,
    {
      method: 'POST',
      headers: { ...jsonHeaders(accessToken), 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({
        filename: input.filename,
        contentType: input.contentType,
        byteSize: input.byteSize
      })
    }
  )
  if (!response.ok) {
    throw new PieChatError(
      `create attachment intent failed with ${response.status}`,
      response.status
    )
  }
  const parsed = PieAttachmentIntentSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('attachment intent response failed schema validation')
  }
  return parsed.data
}

export async function uploadAttachment(
  uploadUrl: string,
  file: ArrayBuffer,
  contentType: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  // Presigned PUT to object storage — no bearer, the signature authorizes it.
  const response = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: file
  })
  if (!response.ok) {
    throw new PieChatError(`upload attachment failed with ${response.status}`, response.status)
  }
}

export async function downloadAttachment(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  attachmentId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieAttachmentDownload> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/attachments/${attachmentId}/download`,
    { headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`download attachment failed with ${response.status}`, response.status)
  }
  const parsed = PieAttachmentDownloadSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('attachment download response failed schema validation')
  }
  return parsed.data
}
