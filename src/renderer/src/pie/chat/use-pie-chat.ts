import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PieChannel,
  PieChatRendererApi,
  PieMessage
} from '../../../../shared/pie-chat-contract'

// A message in the timeline: a server message, optionally an optimistic local
// echo that has not yet been confirmed (pending) or has failed to send.
export type TimelineMessage = PieMessage & {
  optimisticId?: string
  pending?: boolean
  failed?: boolean
}

export type PieChatController = {
  channels: PieChannel[]
  selectedChannelId: string | null
  messages: TimelineMessage[]
  loadingChannels: boolean
  loadingMessages: boolean
  sending: boolean
  error: string | null
  selectChannel: (channelId: string) => void
  sendMessage: (body: string) => Promise<void>
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

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await api.listChannels()
        if (cancelled) {
          return
        }
        setChannels(list)
        setError(null)
        if (list.length > 0) {
          setSelectedChannelId((current) => current ?? list[0].id)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(errorMessage(caught))
        }
      } finally {
        if (!cancelled) {
          setLoadingChannels(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api])

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

  const sendMessage = useCallback(
    async (body: string): Promise<void> => {
      const channelId = selectedRef.current
      const trimmed = body.trim()
      if (!channelId || trimmed.length === 0) {
        return
      }
      const optimisticId = globalThis.crypto.randomUUID()
      const optimistic: TimelineMessage = {
        optimisticId,
        pending: true,
        id: optimisticId,
        organizationId: '',
        channelId,
        authorId: currentUserId,
        body: trimmed,
        visibility: 'internal',
        version: 1,
        threadRootMessageId: null,
        replyCount: 0,
        reactions: [],
        attachments: [],
        createdAt: new Date().toISOString(),
        edited: false,
        revisionCount: 0,
        deleted: false,
        deletedAt: null,
        deletedBy: null,
        deletionReason: null,
        pinned: false
      }
      setMessages((current) => [...current, optimistic])
      setSending(true)
      try {
        const sent = await api.sendMessage(channelId, trimmed)
        setMessages((current) =>
          current.map((message) => (message.optimisticId === optimisticId ? sent : message))
        )
        setError(null)
      } catch (caught) {
        setMessages((current) =>
          current.map((message) =>
            message.optimisticId === optimisticId
              ? { ...message, pending: false, failed: true }
              : message
          )
        )
        setError(errorMessage(caught))
      } finally {
        setSending(false)
      }
    },
    [api, currentUserId]
  )

  return {
    channels,
    selectedChannelId,
    messages,
    loadingChannels,
    loadingMessages,
    sending,
    error,
    selectChannel,
    sendMessage,
    refresh
  }
}
