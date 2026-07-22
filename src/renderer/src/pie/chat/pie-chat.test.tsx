// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PieMessage } from '../../../../shared/pie-chat-contract'
import {
  CHANNEL,
  ORG,
  USER,
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
    const listMessages = vi.fn().mockResolvedValue({ items: [message()], nextCursor: null })
    setChatApi(makeChatApi({ listMessages }))
    ;({ root, container } = renderScreen())
    await flush()

    expect(container.textContent).toContain('general')
    expect(container.textContent).toContain('hello world')
    expect(listMessages).toHaveBeenCalledWith(CHANNEL, { latest: true })
  })

  it('uses the full conversation width until a thread opens', async () => {
    setChatApi(makeChatApi())
    ;({ root, container } = renderScreen())
    await flush()

    const workspace = container.querySelector('main')?.parentElement
    expect(workspace?.className).toContain('grid-cols-[minmax(10rem,13rem)_minmax(0,1fr)]')
    expect(workspace?.className).toContain('xl:grid-cols-[232px_minmax(0,1fr)]')
    expect(container.querySelector('nav[aria-label="Channels"]')).not.toBeNull()
    expect(container.querySelector('aside')).toBeNull()

    const reply = container.querySelector('button[aria-label="Reply"]')
    await act(async () => reply?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    const thread = container.querySelector('aside.w-80')
    expect(thread).not.toBeNull()
    expect(workspace?.className).toContain('xl:grid-cols-[232px_minmax(0,1fr)_264px]')
    expect(thread?.textContent).toContain('Thread')
    expect(thread?.querySelector('button[aria-label="Close thread"]')).not.toBeNull()
  })

  it('loads older messages before the current oldest page', async () => {
    const current = message({
      id: '20000000-0000-4000-8000-000000000020',
      body: 'current page',
      createdAt: '2026-07-16T00:01:00.000Z'
    })
    const older = message({
      id: '20000000-0000-4000-8000-000000000019',
      body: 'older page',
      createdAt: '2026-07-16T00:00:00.000Z'
    })
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [current], nextCursor: current.id })
      .mockResolvedValueOnce({ items: [older], nextCursor: null })
    setChatApi(makeChatApi({ listMessages }))
    ;({ root, container } = renderScreen())
    await flush()

    const loadOlder = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Load older messages'
    )
    await act(async () => {
      loadOlder?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(listMessages).toHaveBeenLastCalledWith(CHANNEL, { before: current.id })
    expect(container.textContent).toContain('older page')
    expect(container.textContent?.indexOf('older page')).toBeLessThan(
      container.textContent?.indexOf('current page') ?? 0
    )
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
    expect(sendMessage).toHaveBeenCalledWith(
      CHANNEL,
      'my new message',
      undefined,
      expect.any(String)
    )
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

    const unpinButton = container.querySelector('button[aria-label="Unpin"]')
    await act(async () => {
      unpinButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(unpinMessage).toHaveBeenCalledWith(CHANNEL, message().id)
  })

  it("edits the author's own message with its current version", async () => {
    const original = message({ authorId: USER, body: 'draft', version: 3 })
    const updated = message({ ...original, body: 'final', version: 4, edited: true })
    const editMessage = vi.fn().mockResolvedValue(updated)
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [original], nextCursor: null })
      .mockResolvedValue({ items: [updated], nextCursor: null })
    setChatApi(makeChatApi({ editMessage, listMessages }))
    ;({ root, container } = renderScreen())
    await flush()

    const edit = container.querySelector('button[aria-label="Edit"]')
    act(() => edit?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      fireEvent.change(textarea, { target: { value: 'final' } })
    })
    const save = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Save'
    )
    await act(async () => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(editMessage).toHaveBeenCalledWith(CHANNEL, original.id, 'final', 3)
    expect(container.textContent).toContain('final')
    expect(container.textContent).toContain('(edited)')
  })

  it("confirms before deleting the author's own message", async () => {
    const original = message({ authorId: USER, body: 'remove me' })
    const tombstone = message({ ...original, body: '', deleted: true })
    const deleteMessage = vi.fn().mockResolvedValue(undefined)
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [original], nextCursor: null })
      .mockResolvedValue({ items: [tombstone], nextCursor: null })
    setChatApi(makeChatApi({ deleteMessage, listMessages }))
    ;({ root, container } = renderScreen())
    await flush()
    const chatScreen = container as HTMLDivElement

    const action = chatScreen.querySelector('button[aria-label="Delete"]')
    act(() => action?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.body.textContent).toContain('Delete message?')
    expect(deleteMessage).not.toHaveBeenCalled()

    const confirmation = Array.from(document.body.querySelectorAll('button')).find(
      (element) => element.textContent === 'Delete' && !chatScreen.contains(element)
    )
    await act(async () => confirmation?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(deleteMessage).toHaveBeenCalledWith(CHANNEL, original.id, undefined)
    expect(chatScreen.textContent).toContain('Message deleted')
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
