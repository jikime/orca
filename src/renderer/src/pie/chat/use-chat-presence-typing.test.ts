// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatPresenceTyping } from './use-chat-presence-typing'
import type {
  PieChatPresenceChanged,
  PieChatRendererApi,
  PieChatTypingChanged
} from '../../../../shared/pie-chat-contract'

const ME = '10000000-0000-4000-8000-000000000001'
const OTHER = '10000000-0000-4000-8000-000000000002'
const CH = '20000000-0000-4000-8000-0000000000c1'
const ORG = '30000000-0000-4000-8000-0000000000aa'

function makeApi(): {
  api: PieChatRendererApi
  sendTyping: ReturnType<typeof vi.fn>
  pushPresence: (event: PieChatPresenceChanged) => void
  pushTyping: (event: PieChatTypingChanged) => void
} {
  let presenceCb: ((event: PieChatPresenceChanged) => void) | null = null
  let typingCb: ((event: PieChatTypingChanged) => void) | null = null
  const sendTyping = vi.fn().mockResolvedValue(undefined)
  const api = {
    sendTyping,
    onPresenceChanged: (cb: (event: PieChatPresenceChanged) => void) => {
      presenceCb = cb
      return () => {
        presenceCb = null
      }
    },
    onTypingChanged: (cb: (event: PieChatTypingChanged) => void) => {
      typingCb = cb
      return () => {
        typingCb = null
      }
    }
  } as unknown as PieChatRendererApi
  return {
    api,
    sendTyping,
    pushPresence: (event) => act(() => presenceCb?.(event)),
    pushTyping: (event) => act(() => typingCb?.(event))
  }
}

const presence = (userId: string, state: 'online' | 'offline'): PieChatPresenceChanged => ({
  type: 'chat.presence-changed',
  organizationId: ORG,
  userId,
  state,
  at: '2026-07-18T00:00:00.000Z'
})

const typing = (userId: string): PieChatTypingChanged => ({
  type: 'chat.typing-changed',
  organizationId: ORG,
  channelId: CH,
  userId,
  at: '2026-07-18T00:00:00.000Z'
})

describe('useChatPresenceTyping', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('tracks online users and removes them when they go offline', () => {
    const harness = makeApi()
    const { result } = renderHook(() => useChatPresenceTyping(harness.api, ME))

    harness.pushPresence(presence(OTHER, 'online'))
    expect(result.current.onlineUserIds.has(OTHER)).toBe(true)

    harness.pushPresence(presence(OTHER, 'offline'))
    expect(result.current.onlineUserIds.has(OTHER)).toBe(false)
  })

  it('shows another user typing, ignores own typing, and self-clears on the TTL', () => {
    const harness = makeApi()
    const { result } = renderHook(() => useChatPresenceTyping(harness.api, ME))

    // Own typing echo must never render.
    harness.pushTyping(typing(ME))
    expect(result.current.typingUserIdsByChannel.get(CH) ?? []).toEqual([])

    harness.pushTyping(typing(OTHER))
    expect(result.current.typingUserIdsByChannel.get(CH)).toEqual([OTHER])

    // No further pings → the indicator self-clears after the TTL.
    act(() => vi.advanceTimersByTime(5001))
    expect(result.current.typingUserIdsByChannel.get(CH)).toBeUndefined()
  })

  it('throttles typing pings but resumes after the window', () => {
    const harness = makeApi()
    const { result } = renderHook(() => useChatPresenceTyping(harness.api, ME))

    act(() => result.current.notifyTyping(CH))
    act(() => result.current.notifyTyping(CH))
    expect(harness.sendTyping).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(2001))
    act(() => result.current.notifyTyping(CH))
    expect(harness.sendTyping).toHaveBeenCalledTimes(2)
  })
})
