// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { channel, message } from './chat-test-fixtures'
import { findUnreadBoundary } from './use-chat-read-tracking'

describe('findUnreadBoundary', () => {
  const first = message({ id: '20000000-0000-4000-8000-000000000011' })
  const second = message({ id: '20000000-0000-4000-8000-000000000012' })
  const third = message({ id: '20000000-0000-4000-8000-000000000013' })

  it('returns the message immediately after the read cursor', () => {
    expect(
      findUnreadBoundary(channel({ unreadCount: 2, lastReadMessageId: first.id }), [
        first,
        second,
        third
      ])
    ).toBe(second.id)
  })

  it('uses the first loaded message when the cursor is older than the page', () => {
    expect(
      findUnreadBoundary(
        channel({
          unreadCount: 80,
          lastReadMessageId: '20000000-0000-4000-8000-000000000001'
        }),
        [first, second]
      )
    ).toBe(first.id)
  })

  it('returns no boundary for a read channel', () => {
    expect(findUnreadBoundary(channel({ unreadCount: 0 }), [first])).toBeNull()
  })
})
