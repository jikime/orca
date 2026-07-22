import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PieChannel,
  PieChatRendererApi,
  PieNotification,
  PieNotificationPreferences
} from '../../../../shared/pie-chat-contract'
import { isChatDndActive } from './chat-do-not-disturb'

export type ChatNotifications = {
  notifications: PieNotification[]
  unreadNotificationCount: number
  loadNotifications: () => Promise<void>
  markNotificationRead: (notificationId: string) => Promise<void>
  markAllNotificationsRead: () => Promise<void>
}

export function useChatNotifications(
  api: PieChatRendererApi,
  channels: PieChannel[]
): ChatNotifications {
  const [notifications, setNotifications] = useState<PieNotification[]>([])
  const preferencesRef = useRef<PieNotificationPreferences | null>(null)
  const knownNotificationIds = useRef<Set<string> | null>(null)

  const deliverDesktopNotification = useCallback(
    async (notification: PieNotification): Promise<void> => {
      const preferences = preferencesRef.current
      if (
        !preferences?.desktopEnabled ||
        isChatDndActive(preferences) ||
        !notification.channelId ||
        !notification.messageId
      ) {
        return
      }
      const channel = channels.find((item) => item.id === notification.channelId)
      let preview = notification.type === 'mention' ? 'Mentioned you' : 'New message'
      try {
        const message = await api.getMessage(notification.channelId, notification.messageId)
        if (message.body.trim()) {
          preview = message.body.trim().slice(0, 180)
        }
      } catch {
        // The durable inbox remains the fallback when the preview read is unavailable.
      }
      const notificationApi = window.api?.notifications
      if (!notificationApi) {
        return
      }
      await notificationApi.dispatch({
        source: 'pie-chat',
        notificationId: notification.id,
        chatChannelId: notification.channelId,
        chatMessageId: notification.messageId,
        chatChannelLabel: channel ? `#${channel.name}` : undefined,
        chatBodyPreview: preview,
        isActiveWorktree: document.hasFocus(),
        worktreeLabel: channel?.name ?? 'Pie chat'
      })
    },
    [api, channels]
  )

  // The durable feed is non-blocking: a temporary notification failure must not
  // hide an otherwise healthy conversation timeline.
  const loadNotifications = useCallback(async (): Promise<void> => {
    try {
      const response = await api.listNotifications()
      setNotifications(response.items)
      const nextIds = new Set(response.items.map((item) => item.id))
      const known = knownNotificationIds.current
      if (known) {
        for (const item of response.items) {
          if (!known.has(item.id) && !item.read) {
            void deliverDesktopNotification(item)
          }
        }
      }
      // The initial read seeds dedupe state; opening Orca must not replay every
      // notification accumulated while the desktop was closed.
      knownNotificationIds.current = nextIds
    } catch {
      setNotifications([])
    }
  }, [api, deliverDesktopNotification])

  useEffect(() => {
    void api
      .getNotificationPreferences()
      .then((preferences) => {
        preferencesRef.current = preferences
      })
      .catch(() => {
        preferencesRef.current = null
      })
    void loadNotifications()
  }, [api, loadNotifications])

  const markNotificationRead = useCallback(
    async (notificationId: string): Promise<void> => {
      setNotifications((current) =>
        current.map((item) =>
          item.id === notificationId ? { ...item, read: true, seen: true } : item
        )
      )
      try {
        await api.markNotificationRead(notificationId)
      } catch {
        void loadNotifications()
      }
    },
    [api, loadNotifications]
  )

  const markAllNotificationsRead = useCallback(async (): Promise<void> => {
    setNotifications((current) => current.map((item) => ({ ...item, read: true, seen: true })))
    try {
      await api.markAllNotificationsRead()
    } catch {
      void loadNotifications()
    }
  }, [api, loadNotifications])

  return {
    notifications,
    unreadNotificationCount: notifications.filter((item) => !item.read).length,
    loadNotifications,
    markNotificationRead,
    markAllNotificationsRead
  }
}
