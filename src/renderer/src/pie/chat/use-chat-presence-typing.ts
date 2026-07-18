import { useCallback, useEffect, useRef, useState } from 'react'
import type { PieChatRendererApi } from '../../../../shared/pie-chat-contract'

// A typing indicator is ephemeral: the backend re-emits while a user keeps typing,
// so each ping arms a short TTL and a stale indicator self-clears if pings stop.
const TYPING_TTL_MS = 5000
// The backend coalesces typing to 1/sec; the renderer additionally throttles so a
// fast typist does not fire an IPC round-trip on every keystroke.
const TYPING_SEND_THROTTLE_MS = 2000

export type ChatPresenceTyping = {
  onlineUserIds: ReadonlySet<string>
  typingUserIdsByChannel: ReadonlyMap<string, string[]>
  notifyTyping: (channelId: string) => void
}

// Subscribes to the ephemeral presence/typing pushes and exposes derived state:
// who is online (org-wide) and who is typing per channel. Kept out of usePieChat
// so the durable message/channel state and the non-durable presence state don't
// tangle. Own-user typing echoes are ignored (you never "type" to yourself).
export function useChatPresenceTyping(
  api: PieChatRendererApi,
  currentUserId: string
): ChatPresenceTyping {
  const [onlineUserIds, setOnlineUserIds] = useState<ReadonlySet<string>>(new Set())
  const [typingByChannel, setTypingByChannel] = useState<ReadonlyMap<string, string[]>>(new Map())
  // channelId -> (userId -> TTL timer id), so each typist's indicator self-clears.
  const typingTimers = useRef(new Map<string, Map<string, number>>())
  const lastSentAt = useRef(0)

  useEffect(() => {
    const unsubscribe = api.onPresenceChanged((event) => {
      setOnlineUserIds((current) => {
        const next = new Set(current)
        if (event.state === 'online') {
          next.add(event.userId)
        } else {
          next.delete(event.userId)
        }
        return next
      })
    })
    // Seed AFTER subscribing (so a frame arriving in between isn't lost): Main
    // cached the initial presence burst that this renderer mounted too late to hear.
    let cancelled = false
    void api
      .getPresenceSnapshot()
      .then((ids) => {
        if (!cancelled) {
          setOnlineUserIds((current) => new Set([...current, ...ids]))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [api])

  useEffect(() => {
    const timers = typingTimers.current
    const clearTypist = (channelId: string, userId: string): void => {
      setTypingByChannel((current) => {
        const list = (current.get(channelId) ?? []).filter((id) => id !== userId)
        const next = new Map(current)
        if (list.length > 0) {
          next.set(channelId, list)
        } else {
          next.delete(channelId)
        }
        return next
      })
    }
    const unsubscribe = api.onTypingChanged((event) => {
      if (event.userId === currentUserId) {
        return
      }
      const { channelId, userId } = event
      setTypingByChannel((current) => {
        if ((current.get(channelId) ?? []).includes(userId)) {
          return current
        }
        const next = new Map(current)
        next.set(channelId, [...(current.get(channelId) ?? []), userId])
        return next
      })
      const channelTimers = timers.get(channelId) ?? new Map<string, number>()
      const existing = channelTimers.get(userId)
      if (existing !== undefined) {
        window.clearTimeout(existing)
      }
      channelTimers.set(
        userId,
        window.setTimeout(() => {
          channelTimers.delete(userId)
          clearTypist(channelId, userId)
        }, TYPING_TTL_MS)
      )
      timers.set(channelId, channelTimers)
    })
    return () => {
      unsubscribe()
      for (const channelTimers of timers.values()) {
        for (const timer of channelTimers.values()) {
          window.clearTimeout(timer)
        }
      }
      timers.clear()
    }
  }, [api, currentUserId])

  const notifyTyping = useCallback(
    (channelId: string) => {
      const now = Date.now()
      if (now - lastSentAt.current < TYPING_SEND_THROTTLE_MS) {
        return
      }
      lastSentAt.current = now
      // Ephemeral fire-and-forget; a dropped typing ping is harmless.
      void api.sendTyping(channelId).catch(() => {})
    },
    [api]
  )

  return { onlineUserIds, typingUserIdsByChannel: typingByChannel, notifyTyping }
}
