// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PinnedBanner } from './PinnedBanner'
import { CHANNEL, flush, makeChatApi, message, pinnedMessage } from './chat-test-fixtures'

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

function renderBanner(api: ReturnType<typeof makeChatApi>): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<PinnedBanner channelId={CHANNEL} api={api} />)
  })
}

describe('PinnedBanner', () => {
  it('shows the most recent pinned message when pins exist', async () => {
    const pin = pinnedMessage(message({ body: 'important note' }))
    const api = makeChatApi({ listPins: vi.fn().mockResolvedValue([pin]) })
    renderBanner(api)
    await flush()

    expect(container?.textContent).toContain('important note')
    expect(container?.textContent).toContain('pinned by')
  })

  it('renders nothing when there are no pins', async () => {
    const api = makeChatApi({ listPins: vi.fn().mockResolvedValue([]) })
    renderBanner(api)
    await flush()

    expect(container?.textContent).toBe('')
  })
})
