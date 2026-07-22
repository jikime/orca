// @vitest-environment happy-dom

import { act } from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CHANNEL, ORG, channel, flush, makeChatApi, message, USER } from './chat-test-fixtures'
import { usePieChat } from './use-pie-chat'

describe('usePieChat', () => {
  function numberedMessage(index: number) {
    return message({
      id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      body: `message ${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 16, 0, index)).toISOString()
    })
  }

  it('sends an attachment-only message instead of dropping its empty caption', async () => {
    const sent = message({ authorId: USER, body: '' })
    const sendMessage = vi.fn().mockResolvedValue(sent)
    const api = makeChatApi({ sendMessage })
    const { result } = renderHook(() => usePieChat(USER, api))
    await flush()

    await act(async () => {
      await result.current.sendMessage('', { attachmentIds: ['att-1'] })
    })

    expect(sendMessage).toHaveBeenCalledWith(
      CHANNEL,
      '',
      { attachmentIds: ['att-1'] },
      expect.any(String)
    )
  })

  it('retries a failed optimistic message with the same client request id', async () => {
    const sent = message({ authorId: USER, body: 'retry me' })
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(sent)
    const api = makeChatApi({ sendMessage })
    const { result } = renderHook(() => usePieChat(USER, api))
    await flush()

    await act(async () => {
      await result.current.sendMessage('retry me').catch(() => {})
    })
    const failed = result.current.messages.find((item) => item.failed)
    expect(failed?.pending).toBe(false)
    expect(failed?.retryPayload?.body).toBe('retry me')

    await act(async () => result.current.retryMessage(failed?.optimisticId ?? ''))

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[1]?.[3]).toBe(sendMessage.mock.calls[0]?.[3])
    expect(result.current.messages.some((item) => item.id === sent.id && !item.failed)).toBe(true)
  })

  it('dismisses only a failed optimistic message', async () => {
    const api = makeChatApi({ sendMessage: vi.fn().mockRejectedValue(new Error('offline')) })
    const { result } = renderHook(() => usePieChat(USER, api))
    await flush()
    await act(async () => result.current.sendMessage('drop me').catch(() => {}))
    const failedId = result.current.messages.find((item) => item.failed)?.optimisticId ?? ''

    act(() => result.current.dismissFailedMessage(failedId))

    expect(result.current.messages.some((item) => item.optimisticId === failedId)).toBe(false)
  })

  it('injects a search result that is outside the loaded latest page', async () => {
    const api = makeChatApi()
    const { result } = renderHook(() => usePieChat(USER, api))
    await flush()
    const olderResult = message({
      id: '20000000-0000-4000-8000-000000000099',
      body: 'search target',
      createdAt: '2026-07-15T00:00:00.000Z'
    })

    act(() => result.current.focusMessage(olderResult))

    expect(result.current.messages.some((item) => item.id === olderResult.id)).toBe(true)
  })

  it('captures the unread boundary and advances read only when the timeline reports visibility', async () => {
    const first = message({ id: '20000000-0000-4000-8000-000000000011' })
    const unread = message({ id: '20000000-0000-4000-8000-000000000012' })
    const markRead = vi.fn().mockResolvedValue(undefined)
    const api = makeChatApi({
      listChannels: vi
        .fn()
        .mockResolvedValue([channel({ unreadCount: 1, lastReadMessageId: first.id })]),
      listMessages: vi.fn().mockResolvedValue({ items: [first, unread], nextCursor: null }),
      markRead
    })
    const { result } = renderHook(() => usePieChat(USER, api))
    await flush()

    expect(result.current.unreadBoundaryMessageId).toBe(unread.id)
    expect(markRead).not.toHaveBeenCalled()

    await act(async () => result.current.markReadThrough(CHANNEL, unread.id))

    expect(markRead).toHaveBeenCalledWith(CHANNEL, unread.id)
    expect(result.current.unreadBoundaryMessageId).toBeNull()
  })

  it('keeps 50+ latest, history, and realtime pages ordered without duplicate ids', async () => {
    const latest = Array.from({ length: 50 }, (_, index) => numberedMessage(index + 6))
    const history = Array.from({ length: 6 }, (_, index) => numberedMessage(index + 1))
    const realtime = [...latest.slice(1), numberedMessage(56)]
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: latest, nextCursor: latest[0]?.id })
      .mockResolvedValueOnce({ items: history, nextCursor: null })
      .mockResolvedValueOnce({ items: realtime, nextCursor: null })
    const api = makeChatApi({ listMessages })
    const { result } = renderHook(() => usePieChat(USER, api))
    await flush()

    expect(result.current.messages).toHaveLength(50)
    await act(async () => result.current.loadOlderMessages())
    expect(result.current.messages).toHaveLength(55)

    await act(async () => {
      api.changedCallbacks.forEach((callback) =>
        callback({ type: 'chat.messages-changed', organizationId: ORG })
      )
      await Promise.resolve()
    })
    await flush()

    const ids = result.current.messages.map((item) => item.id)
    expect(ids).toHaveLength(56)
    expect(new Set(ids).size).toBe(56)
    expect(result.current.messages.at(0)?.body).toBe('message 1')
    expect(result.current.messages.at(-1)?.body).toBe('message 56')
  })
})
