import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PieChannel,
  PieChatMember,
  PieChatRendererApi,
  PieMessage,
  PieSendMessageOptions
} from '../../../../shared/pie-chat-contract'
import { createOptimisticMessage } from './optimistic-message'
import { isReactedByMe, toggleReactionLocally } from './apply-optimistic-reaction'

// A message in the timeline: a server message, optionally an optimistic local
// echo that has not yet been confirmed (pending) or has failed to send.
export type TimelineMessage = PieMessage & {
  optimisticId?: string
  pending?: boolean
  failed?: boolean
}

export type PieChatController = {
  api: PieChatRendererApi
  currentUserId: string
  channels: PieChannel[]
  members: PieChatMember[]
  selectedChannelId: string | null
  messages: TimelineMessage[]
  loadingChannels: boolean
  loadingMessages: boolean
  sending: boolean
  error: string | null
  selectChannel: (channelId: string) => void
  selectChannelObject: (channel: PieChannel) => void
  sendMessage: (body: string, opts?: PieSendMessageOptions) => Promise<void>
  toggleReaction: (messageId: string, emoji: string) => Promise<void>
  refresh: () => void
}

// Refetch the active channel on this cadence as a live-update fallback while the
// realtime resource-change union does not yet carry a message resourceType.
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
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track the active channel in a ref so subscriptions/pollers read the latest
  // value without re-subscribing on every selection change.
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedChannelId

  const loadMessages = useCallback(
    async (channelId: string): Promise<void> => {
      setLoadingMessages(true)
      try {
        const response = await api.listMessages(channelId)
        // Ignore a response for a channel the user already navigated away from.
        if (selectedRef.current !== channelId) {
          return
        }
        setMessages(response.items)
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
    [api]
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
      void loadMessages(selectedChannelId)
    }
  }, [selectedChannelId, loadMessages])

  const refresh = useCallback(() => {
    const channelId = selectedRef.current
    if (channelId) {
      void loadMessages(channelId)
    }
  }, [loadMessages])

  // Live updates: a Main push nudge, a poll on window focus, and a slow interval.
  useEffect(() => {
    const unsubscribe = api.onMessagesChanged(() => refresh())
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', onFocus)
      window.clearInterval(interval)
    }
  }, [api, refresh])

  const selectChannel = useCallback((channelId: string) => {
    setSelectedChannelId(channelId)
    setMessages([])
  }, [])

  const selectChannelObject = useCallback((channel: PieChannel) => {
    // Newly created channels/DMs are not in the loaded list yet — add and select.
    setChannels((current) =>
      current.some((existing) => existing.id === channel.id) ? current : [...current, channel]
    )
    setSelectedChannelId(channel.id)
    setMessages([])
  }, [])

  const sendMessage = useCallback(
    async (body: string, opts?: PieSendMessageOptions): Promise<void> => {
      const channelId = selectedRef.current
      const trimmed = body.trim()
      if (!channelId || trimmed.length === 0) {
        return
      }
      const optimistic = createOptimisticMessage(channelId, currentUserId, trimmed, opts)
      // A threaded reply is not shown in the main timeline; the thread panel
      // refetches itself. Only echo top-level messages here.
      const echo = opts?.threadRootMessageId === undefined
      if (echo) {
        setMessages((current) => [...current, optimistic])
      }
      setSending(true)
      try {
        const sent = await api.sendMessage(channelId, trimmed, opts)
        if (echo) {
          setMessages((current) =>
            current.map((message) =>
              message.optimisticId === optimistic.optimisticId ? sent : message
            )
          )
        }
        setError(null)
      } catch (caught) {
        if (echo) {
          setMessages((current) =>
            current.map((message) =>
              message.optimisticId === optimistic.optimisticId
                ? { ...message, pending: false, failed: true }
                : message
            )
          )
        }
        setError(errorMessage(caught))
      } finally {
        setSending(false)
      }
    },
    [api, currentUserId]
  )

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

  return {
    api,
    currentUserId,
    channels,
    members,
    selectedChannelId,
    messages,
    loadingChannels,
    loadingMessages,
    sending,
    error,
    selectChannel,
    selectChannelObject,
    sendMessage,
    toggleReaction,
    refresh
  }
}
