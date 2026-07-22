import {
  PieNotificationListResponseSchema,
  PieNotificationSchema,
  PieNotificationsReadAllResponseSchema,
  PieNotificationPreferencesSchema,
  type PieNotification,
  type PieNotificationListResponse,
  type PieNotificationPreferences,
  type PieNotificationPreferencesUpdate,
  type PieChannelNotificationLevel
} from '../../shared/pie-chat-contract'
import { authHeaders, jsonHeaders, orgBase, PieChatError } from './chat-control-plane-http'

// The caller's own durable notification feed. All routes are org-scoped and
// per-user (RLS restricts every row to the caller). mark-read is naturally
// idempotent, so — unlike send/reaction — it reserves no Idempotency-Key.

function notificationsBase(apiBaseUrl: string, organizationId: string): string {
  return `${orgBase(apiBaseUrl, organizationId)}/notifications`
}

export async function listNotifications(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieNotificationListResponse> {
  const response = await fetchImpl(notificationsBase(apiBaseUrl, organizationId), {
    headers: authHeaders(accessToken)
  })
  if (!response.ok) {
    throw new PieChatError(`list notifications failed with ${response.status}`, response.status)
  }
  const parsed = PieNotificationListResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('notification list response failed schema validation')
  }
  return parsed.data
}

export async function markNotificationRead(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  notificationId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieNotification> {
  const response = await fetchImpl(
    `${notificationsBase(apiBaseUrl, organizationId)}/${notificationId}/read`,
    { method: 'POST', headers: authHeaders(accessToken) }
  )
  if (!response.ok) {
    throw new PieChatError(`mark notification read failed with ${response.status}`, response.status)
  }
  const parsed = PieNotificationSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('notification response failed schema validation')
  }
  return parsed.data
}

export async function markAllNotificationsRead(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  // The read-all action rides a colon-suffixed sub-resource, matching the route.
  const response = await fetchImpl(`${notificationsBase(apiBaseUrl, organizationId)}:read-all`, {
    method: 'POST',
    headers: authHeaders(accessToken)
  })
  if (!response.ok) {
    throw new PieChatError(
      `mark all notifications read failed with ${response.status}`,
      response.status
    )
  }
  const parsed = PieNotificationsReadAllResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new PieChatError('read-all response failed schema validation')
  }
  return parsed.data.updated
}

export async function getNotificationPreferences(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieNotificationPreferences> {
  const response = await fetchImpl(`${notificationsBase(apiBaseUrl, organizationId)}/preferences`, {
    headers: authHeaders(accessToken)
  })
  if (!response.ok) {
    throw new PieChatError(
      `get notification preferences failed with ${response.status}`,
      response.status
    )
  }
  return PieNotificationPreferencesSchema.parse(await response.json())
}

export async function updateNotificationPreferences(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  update: PieNotificationPreferencesUpdate,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<PieNotificationPreferences> {
  const response = await fetchImpl(`${notificationsBase(apiBaseUrl, organizationId)}/preferences`, {
    method: 'PUT',
    headers: { ...jsonHeaders(accessToken), 'idempotency-key': idempotencyKey },
    body: JSON.stringify(update)
  })
  if (!response.ok) {
    throw new PieChatError(
      `update notification preferences failed with ${response.status}`,
      response.status
    )
  }
  return PieNotificationPreferencesSchema.parse(await response.json())
}

export async function setChannelNotificationLevel(
  apiBaseUrl: string,
  accessToken: string,
  organizationId: string,
  channelId: string,
  level: PieChannelNotificationLevel,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `${orgBase(apiBaseUrl, organizationId)}/channels/${channelId}/notification-level`,
    {
      method: 'PUT',
      headers: { ...jsonHeaders(accessToken), 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ level })
    }
  )
  if (!response.ok) {
    throw new PieChatError(
      `set channel notification level failed with ${response.status}`,
      response.status
    )
  }
}
