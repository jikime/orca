import { z } from 'zod'
import {
  PieChannelAuditEntrySchema,
  PieChannelExportSchema,
  type PieChannelAuditEntry,
  type PieChannelExport
} from '../../shared/pie-chat-contract'
import { authHeaders, channelsBase, PieChatError } from './chat-control-plane-http'

const ChannelAuditListSchema = z
  .object({ items: z.array(PieChannelAuditEntrySchema) })
  .passthrough()
const RetentionApplySchema = z
  .object({ ok: z.literal(true), redactedCount: z.number().int().min(0) })
  .passthrough()

export async function listChannelAudit(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieChannelAuditEntry[]> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/audit`,
    { headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`list channel audit failed with ${response.status}`, response.status)
  }
  const parsed = ChannelAuditListSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('channel audit response failed schema validation')
  }
  return parsed.data.items
}

export async function exportChannel(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieChannelExport> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/export`,
    { headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`export channel failed with ${response.status}`, response.status)
  }
  const parsed = PieChannelExportSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('channel export response failed schema validation')
  }
  return parsed.data
}

export async function applyChannelRetention(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  input: { idempotencyKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  const response = await fetchImpl(
    `${channelsBase(apiBaseUrl, organizationId)}/${channelId}/retention:apply`,
    {
      method: 'POST',
      headers: { ...authHeaders(accessToken), 'idempotency-key': input.idempotencyKey }
    }
  )
  if (!response.ok) {
    throw new PieChatError(
      `apply channel retention failed with ${response.status}`,
      response.status
    )
  }
  const parsed = RetentionApplySchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('retention response failed schema validation')
  }
  return parsed.data.redactedCount
}
