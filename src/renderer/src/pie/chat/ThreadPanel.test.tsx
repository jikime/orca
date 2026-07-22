// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadPanel } from './ThreadPanel'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  CHANNEL,
  USER,
  flush,
  makeChatApi,
  member,
  message,
  pressEnter,
  typeInto
} from './chat-test-fixtures'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

function renderThread(api: ReturnType<typeof makeChatApi>): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const rootMessage = message({ id: CHANNEL, body: 'thread root' })
  act(() => {
    root?.render(
      <TooltipProvider>
        <ThreadPanel
          channelId={CHANNEL}
          root={rootMessage}
          currentUserId={USER}
          members={[member(USER, 'Ada')]}
          api={api}
          onClose={vi.fn()}
          onReplied={vi.fn()}
        />
      </TooltipProvider>
    )
  })
}

describe('ThreadPanel', () => {
  it('loads replies filtered by the thread root and renders them', async () => {
    const listMessages = vi.fn().mockResolvedValue({
      items: [message({ id: '20000000-0000-4000-8000-0000000000c1', body: 'a reply' })],
      nextCursor: null
    })
    const api = makeChatApi({ listMessages })
    renderThread(api)
    await flush()

    expect(listMessages).toHaveBeenCalledWith(CHANNEL, { threadRoot: CHANNEL })
    expect(container?.textContent).toContain('a reply')
  })

  it('posts a reply with the thread root id', async () => {
    const sendMessage = vi.fn().mockResolvedValue(message({ authorId: USER }))
    const api = makeChatApi({
      sendMessage,
      listMessages: vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    })
    renderThread(api)
    await flush()

    await act(async () => {
      typeInto(container as HTMLElement, 'my reply')
    })
    await act(async () => {
      pressEnter(container as HTMLElement)
    })
    await flush()

    expect(sendMessage).toHaveBeenCalledWith(
      CHANNEL,
      'my reply',
      { threadRootMessageId: CHANNEL },
      expect.any(String)
    )
  })

  it('preserves structured group mentions on a threaded reply', async () => {
    const sendMessage = vi.fn().mockResolvedValue(message({ authorId: USER }))
    const api = makeChatApi({
      sendMessage,
      listMessages: vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    })
    renderThread(api)
    await flush()

    await act(async () => typeInto(container as HTMLElement, '@channel please review'))
    await act(async () => pressEnter(container as HTMLElement))
    await flush()

    expect(sendMessage).toHaveBeenCalledWith(
      CHANNEL,
      '@channel please review',
      {
        mentionChannel: true,
        threadRootMessageId: CHANNEL
      },
      expect.any(String)
    )
  })

  it("edits the author's own reply using its current version", async () => {
    const original = message({ authorId: USER, body: 'draft reply', version: 2 })
    const updated = message({ ...original, body: 'final reply', version: 3, edited: true })
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [original], nextCursor: null })
      .mockResolvedValue({ items: [updated], nextCursor: null })
    const editMessage = vi.fn().mockResolvedValue(updated)
    renderThread(makeChatApi({ listMessages, editMessage }))
    await flush()

    const edit = container?.querySelector('button[aria-label="Edit"]')
    act(() => edit?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    act(() => fireEvent.change(textarea, { target: { value: 'final reply' } }))
    const save = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Save'
    )
    await act(async () => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(editMessage).toHaveBeenCalledWith(CHANNEL, original.id, 'final reply', 2)
    expect(container?.textContent).toContain('(edited)')
  })

  it('refreshes open replies when realtime nudges the chat surface', async () => {
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValue({ items: [message({ body: 'live reply' })], nextCursor: null })
    const api = makeChatApi({ listMessages })
    renderThread(api)
    await flush()

    await act(async () => {
      api.changedCallbacks.forEach((callback) =>
        callback({ type: 'chat.messages-changed', organizationId: message().organizationId })
      )
    })
    await flush()

    expect(container?.textContent).toContain('live reply')
  })
})
