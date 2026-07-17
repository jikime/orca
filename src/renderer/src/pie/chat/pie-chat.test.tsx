// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PieMessage } from '../../../../shared/pie-chat-contract'
import {
  CHANNEL,
  ORG,
  flush,
  makeChatApi,
  message,
  pressEnter,
  renderScreen,
  setChatApi,
  typeInto
} from './chat-test-fixtures'

describe('Pie chat renderer', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('renders channels and messages for the selected channel', async () => {
    setChatApi(makeChatApi())
    ;({ root, container } = renderScreen())
    await flush()

    expect(container.textContent).toContain('general')
    expect(container.textContent).toContain('hello world')
  })

  it('optimistically appends a sent message before the server responds', async () => {
    let resolveSend: (value: PieMessage) => void = () => {}
    const sendMessage = vi
      .fn()
      .mockImplementation(() => new Promise<PieMessage>((resolve) => (resolveSend = resolve)))
    setChatApi(makeChatApi({ sendMessage }))
    ;({ root, container } = renderScreen())
    await flush()

    await act(async () => {
      typeInto(container as HTMLElement, 'my new message')
    })
    await act(async () => {
      pressEnter(container as HTMLElement)
    })

    // Appears immediately, before the send promise resolves.
    expect(container.textContent).toContain('my new message')
    expect(sendMessage).toHaveBeenCalledWith(CHANNEL, 'my new message', undefined)
    resolveSend(
      message({
        id: '20000000-0000-4000-8000-000000000099',
        body: 'my new message',
        authorId: '20000000-0000-4000-8000-0000000000aa'
      })
    )
    await flush()
  })

  it('renders a tombstone for a deleted message', async () => {
    setChatApi(
      makeChatApi({
        listMessages: vi
          .fn()
          .mockResolvedValue({ items: [message({ deleted: true, body: '' })], nextCursor: null })
      })
    )
    ;({ root, container } = renderScreen())
    await flush()

    expect(container.textContent).toContain('Message deleted')
  })

  it('unpins a pinned message through the timeline action', async () => {
    const unpinMessage = vi.fn().mockResolvedValue(undefined)
    setChatApi(
      makeChatApi({
        listMessages: vi
          .fn()
          .mockResolvedValue({ items: [message({ pinned: true })], nextCursor: null }),
        unpinMessage
      })
    )
    ;({ root, container } = renderScreen())
    await flush()

    const unpinButton = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Unpin'
    )
    await act(async () => {
      unpinButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(unpinMessage).toHaveBeenCalledWith(CHANNEL, message().id)
  })

  it('live-updates the timeline on an onMessagesChanged event', async () => {
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [message({ body: 'first' })], nextCursor: null })
      .mockResolvedValue({
        items: [
          message({ body: 'first' }),
          message({ id: '20000000-0000-4000-8000-000000000020', body: 'second' })
        ],
        nextCursor: null
      })
    const chat = makeChatApi({ listMessages })
    setChatApi(chat)
    ;({ root, container } = renderScreen())
    await flush()
    expect(container.textContent).toContain('first')
    expect(container.textContent).not.toContain('second')

    await act(async () => {
      chat.changedCallbacks.forEach((callback) =>
        callback({ type: 'chat.messages-changed', organizationId: ORG })
      )
    })
    await flush()

    expect(container.textContent).toContain('second')
  })
})
