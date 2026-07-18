import {
  PieNotificationListResponseSchema,
  PieNotificationSchema,
  PieNotificationsReadAllResponseSchema,
  type PieNotification,
  type PieNotificationListResponse
} from '../../shared/pie-chat-contract'
import { authHeaders, orgBase, PieChatError } from './chat-control-plane-http'

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
  const response = await fetchImpl(
    `${notificationsBase(apiBaseUrl, organizationId)}:read-all`,
    { method: 'POST', headers: authHeaders(accessToken) }
  )
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
