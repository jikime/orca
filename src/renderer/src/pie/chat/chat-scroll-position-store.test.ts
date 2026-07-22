// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  chatScrollPositionKey,
  readChatScrollPosition,
  writeChatScrollPosition
} from './chat-scroll-position-store'

describe('chat scroll position store', () => {
  beforeEach(() => window.localStorage.clear())

  it('isolates root and thread positions', () => {
    expect(chatScrollPositionKey('u1', 'c1')).not.toBe(chatScrollPositionKey('u1', 'c1', 'm1'))
  })

  it('round-trips a safe scroll position', () => {
    const key = chatScrollPositionKey('u1', 'c1')
    writeChatScrollPosition(key, { scrollTop: 120, scrollHeight: 900, atBottom: false })
    expect(readChatScrollPosition(key)).toEqual({
      scrollTop: 120,
      scrollHeight: 900,
      atBottom: false
    })
  })
})
