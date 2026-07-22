import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { TimelineMessage } from './pie-chat-controller'
import {
  chatScrollPositionKey,
  readChatScrollPosition,
  writeChatScrollPosition
} from './chat-scroll-position-store'

const BOTTOM_THRESHOLD_PX = 48

type TimelineScrollInput = {
  viewportRef: RefObject<HTMLDivElement | null>
  ownerId: string
  channelId: string
  messages: TimelineMessage[]
  unreadBoundaryMessageId: string | null
  focusedMessageId: string | null
  onReadThrough: (messageId: string) => void
}

type TimelineScrollController = {
  hasNewMessages: boolean
  scrollToNewest: () => void
}

function isAtBottom(viewport: HTMLDivElement): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX
}

export function useMessageTimelineScroll({
  viewportRef,
  ownerId,
  channelId,
  messages,
  unreadBoundaryMessageId,
  focusedMessageId,
  onReadThrough
}: TimelineScrollInput): TimelineScrollController {
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const initializedChannelRef = useRef<string | null>(null)
  const previousNewestRef = useRef<string | undefined>(undefined)
  const lastMarkedRef = useRef<string | null>(null)
  const atBottomRef = useRef(true)
  const storageKey = chatScrollPositionKey(ownerId, channelId)
  const newestServerMessage = messages.toReversed().find((message) => !message.optimisticId)

  const markVisibleRead = useCallback((): void => {
    if (!newestServerMessage || lastMarkedRef.current === newestServerMessage.id) {
      return
    }
    lastMarkedRef.current = newestServerMessage.id
    onReadThrough(newestServerMessage.id)
  }, [newestServerMessage, onReadThrough])

  const savePosition = useCallback((): void => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    const atBottom = isAtBottom(viewport)
    atBottomRef.current = atBottom
    writeChatScrollPosition(storageKey, {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      atBottom
    })
    if (atBottom) {
      setHasNewMessages(false)
      markVisibleRead()
    }
  }, [markVisibleRead, storageKey, viewportRef])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    viewport.addEventListener('scroll', savePosition, { passive: true })
    return () => viewport.removeEventListener('scroll', savePosition)
  }, [savePosition, viewportRef])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || messages.length === 0 || initializedChannelRef.current === channelId) {
      return
    }
    const boundary = unreadBoundaryMessageId
      ? viewport.querySelector<HTMLElement>(`[data-message-id="${unreadBoundaryMessageId}"]`)
      : null
    const saved = readChatScrollPosition(storageKey)
    if (boundary) {
      viewport.scrollTop = Math.max(0, boundary.offsetTop - 12)
    } else if (saved && !saved.atBottom) {
      viewport.scrollTop = saved.scrollTop
    } else {
      viewport.scrollTop = viewport.scrollHeight
    }
    initializedChannelRef.current = channelId
    previousNewestRef.current = messages.at(-1)?.id
    atBottomRef.current = isAtBottom(viewport)
    if (atBottomRef.current) {
      markVisibleRead()
    }
  }, [channelId, markVisibleRead, messages, storageKey, unreadBoundaryMessageId, viewportRef])

  useEffect(() => {
    const viewport = viewportRef.current
    const newest = messages.at(-1)?.id
    if (!viewport || initializedChannelRef.current !== channelId || !newest) {
      return
    }
    if (previousNewestRef.current && previousNewestRef.current !== newest) {
      if (atBottomRef.current) {
        viewport.scrollTop = viewport.scrollHeight
        markVisibleRead()
      } else {
        setHasNewMessages(true)
      }
    }
    previousNewestRef.current = newest
  }, [channelId, markVisibleRead, messages, viewportRef])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !focusedMessageId) {
      return
    }
    const target = viewport.querySelector<HTMLElement>(`[data-message-id="${focusedMessageId}"]`)
    if (target) {
      viewport.scrollTop = Math.max(
        0,
        target.offsetTop - (viewport.clientHeight - target.offsetHeight) / 2
      )
    }
  }, [focusedMessageId, messages, viewportRef])

  const scrollToNewest = useCallback((): void => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    viewport.scrollTop = viewport.scrollHeight
    atBottomRef.current = true
    setHasNewMessages(false)
    markVisibleRead()
    savePosition()
  }, [markVisibleRead, savePosition, viewportRef])

  return { hasNewMessages, scrollToNewest }
}
