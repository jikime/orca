// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadPanel } from './ThreadPanel'
import {
  CHANNEL,
  USER,
  flush,
  makeChatApi,
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
      <ThreadPanel
        channelId={CHANNEL}
        root={rootMessage}
        currentUserId={USER}
        api={api}
        onClose={vi.fn()}
        onReplied={vi.fn()}
      />
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

    expect(sendMessage).toHaveBeenCalledWith(CHANNEL, 'my reply', { threadRootMessageId: CHANNEL })
  })
})
