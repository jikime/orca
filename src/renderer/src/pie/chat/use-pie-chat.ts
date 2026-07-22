import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PieChannel,
  PieChatMember,
  PieChatRendererApi,
  PieMessage
} from '../../../../shared/pie-chat-contract'
import { isReactedByMe, toggleReactionLocally } from './apply-optimistic-reaction'
import { useChatPresenceTyping } from './use-chat-presence-typing'
import { mergeChatTimeline } from './merge-chat-timeline'
import { useChatNotifications } from './use-chat-notifications'
import type { PieChatController, TimelineMessage } from './pie-chat-controller'
import { useChatMessageDelivery } from './use-chat-message-delivery'
import { useChatReadTracking } from './use-chat-read-tracking'

export type { PieChatController, TimelineMessage } from './pie-chat-controller'

// Refetch on a slow cadence as a recovery path for a push missed during
// reconnect; normal message updates arrive through onMessagesChanged.
const POLL_INTERVAL_MS = 15000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'chat request failed'
}

export function usePieChat(
  currentUserId: string,
  api: PieChatRendererApi = window.api.pie.chat
): PieChatController {
  const [channels, setChannels] = useState<PieChannel[]>([])
  const [members, setMembers] = useState<PieChatMember[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [messages, setMessages] = useState<TimelineMessage[]>([])
  const [loadingChannels, setLoadingChannels] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const channelsRef = useRef(channels)
  channelsRef.current = channels
  const {
    notifications,
    unreadNotificationCount,
    loadNotifications,
    markNotificationRead,
    markAllNotificationsRead
  } = useChatNotifications(api, channels)

  // Track the active channel in a ref so subscriptions/pollers read the latest
  // value without re-subscribing on every selection change.
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedChannelId
  const { sending, sendMessage, retryMessage, dismissFailedMessage } = useChatMessageDelivery({
    api,
    currentUserId,
    selectedChannelIdRef: selectedRef,
    messagesRef,
    setMessages,
    setError
  })
  const { unreadBoundaryMessageId, captureUnreadBoundary, markReadThrough, resetUnreadBoundary } =
    useChatReadTracking(api, setChannels)

  const loadMessages = useCallback(
    async (channelId: string, trackOlderPage = false): Promise<void> => {
      setLoadingMessages(true)
      try {
        const response = await api.listMessages(channelId, { latest: true })
        // Ignore a response for a channel the user already navigated away from.
        if (selectedRef.current !== channelId) {
          return
        }
        setMessages((current) => mergeChatTimeline(current, response.items))
        if (trackOlderPage) {
          setHasOlderMessages(response.nextCursor !== null)
          captureUnreadBoundary(
            channelsRef.current.find((channel) => channel.id === channelId),
            response.items
          )
        }
        setError(null)
      } catch (caught) {
        if (selectedRef.current === channelId) {
          setError(errorMessage(caught))
        }
      } finally {
        if (selectedRef.current === channelId) {
          setLoadingMessages(false)
        }
      }
    },
    [api, captureUnreadBoundary]
  )

  const loadChannels = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listChannels()
      setChannels(list)
      setError(null)
      if (list.length > 0) {
        setSelectedChannelId((current) => current ?? list[0].id)
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoadingChannels(false)
    }
  }, [api])

  useEffect(() => {
    void loadChannels()
    // Members feed @-mention autocomplete and DM targeting; a failure here is
    // non-fatal (autocomplete just stays empty) so it does not surface an error.
    void api
      .listMembers()
      .then(setMembers)
      .catch(() => setMembers([]))
  }, [api, loadChannels])

  useEffect(() => {
    if (selectedChannelId) {
      void loadMessages(selectedChannelId, true)
    }
  }, [selectedChannelId, loadMessages])

  const refresh = useCallback(async (): Promise<void> => {
    const channelId = selectedRef.current
    if (channelId) {
      await loadMessages(channelId)
    }
  }, [loadMessages])

  // Live updates: a Main push nudge, a poll on window focus, and a slow interval.
  // A mention creates a notification, so every nudge also refreshes the inbox.
  useEffect(() => {
    const tick = (): void => {
      void refresh()
      void loadNotifications()
      // Refresh the channel list so unread badges reflect messages in other channels.
      void loadChannels()
    }
    const unsubscribe = api.onMessagesChanged(tick)
    window.addEventListener('focus', tick)
    const interval = window.setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', tick)
      window.clearInterval(interval)
    }
  }, [api, refresh, loadNotifications, loadChannels])

  const selectChannel = useCallback(
    (channelId: string) => {
      setSelectedChannelId(channelId)
      setMessages([])
      setHasOlderMessages(false)
      resetUnreadBoundary()
    },
    [resetUnreadBoundary]
  )

  const selectChannelObject = useCallback(
    (channel: PieChannel) => {
      // Newly created channels/DMs are not in the loaded list yet — add and select.
      setChannels((current) =>
        current.some((existing) => existing.id === channel.id) ? current : [...current, channel]
      )
      setSelectedChannelId(channel.id)
      setMessages([])
      setHasOlderMessages(false)
      resetUnreadBoundary()
    },
    [resetUnreadBoundary]
  )

  const replaceChannel = useCallback((channel: PieChannel): void => {
    setChannels((current) =>
      current.map((existing) => (existing.id === channel.id ? channel : existing))
    )
  }, [])

  const focusMessage = useCallback((message: PieMessage): void => {
    const changingChannel = selectedRef.current !== message.channelId
    setSelectedChannelId(message.channelId)
    setMessages((current) =>
      changingChannel
        ? [message]
        : current.some((item) => item.id === message.id)
          ? current
          : mergeChatTimeline(current, [message])
    )
    if (changingChannel) {
      setHasOlderMessages(true)
    }
  }, [])

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    const channelId = selectedRef.current
    const oldest = messages.find((message) => !message.optimisticId)
    if (!channelId || !oldest || loadingOlderMessages || !hasOlderMessages) {
      return
    }
    setLoadingOlderMessages(true)
    try {
      const response = await api.listMessages(channelId, { before: oldest.id })
      if (selectedRef.current === channelId) {
        setMessages((current) => mergeChatTimeline(current, response.items))
        setHasOlderMessages(response.nextCursor !== null)
        setError(null)
      }
    } catch (caught) {
      if (selectedRef.current === channelId) {
        setError(errorMessage(caught))
      }
    } finally {
      setLoadingOlderMessages(false)
    }
  }, [api, hasOlderMessages, loadingOlderMessages, messages])

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string): Promise<void> => {
      const channelId = selectedRef.current
      if (!channelId) {
        return
      }
      const target = messages.find((message) => message.id === messageId)
      if (!target) {
        return
      }
      const remove = isReactedByMe(target, emoji)
      // Optimistic toggle; revert to the prior snapshot if the call fails.
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId ? toggleReactionLocally(message, emoji) : message
        )
      )
      try {
        if (remove) {
          await api.removeReaction(channelId, messageId, emoji)
        } else {
          const updated = await api.addReaction(channelId, messageId, emoji)
          setMessages((current) =>
            current.map((message) =>
              message.id === messageId ? { ...message, ...updated } : message
            )
          )
        }
        setError(null)
      } catch (caught) {
        setMessages((current) =>
          current.map((message) => (message.id === messageId ? target : message))
        )
        setError(errorMessage(caught))
      }
    },
    [api, messages]
  )

  const { onlineUserIds, typingUserIdsByChannel, notifyTyping } = useChatPresenceTyping(
    api,
    currentUserId
  )

  // The channel you are viewing never shows an unread badge, even before the next
  // list refresh confirms the read cursor moved.
  const displayChannels = channels.map((channel) =>
    channel.id === selectedChannelId && (channel.unreadCount ?? 0) > 0
      ? { ...channel, unreadCount: 0 }
      : channel
  )

  return {
    api,
    currentUserId,
    channels: displayChannels,
    members,
    selectedChannelId,
    messages,
    unreadBoundaryMessageId,
    notifications,
    unreadNotificationCount,
    onlineUserIds,
    typingUserIdsByChannel,
    notifyTyping,
    loadingChannels,
    loadingMessages,
    loadingOlderMessages,
    hasOlderMessages,
    sending,
    error,
    selectChannel,
    selectChannelObject,
    replaceChannel,
    focusMessage,
    sendMessage,
    retryMessage,
    dismissFailedMessage,
    markReadThrough,
    toggleReaction,
    markNotificationRead,
    markAllNotificationsRead,
    refresh,
    loadOlderMessages
  }
}
