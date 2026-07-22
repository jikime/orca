// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageTimeline } from './MessageTimeline'
import { CHANNEL, OTHER, USER, member, message } from './chat-test-fixtures'

let root: Root | null = null
let container: HTMLDivElement | null = null
const scrollIntoView = vi.fn()

function renderTimeline(
  messages = [message()],
  callbacks: {
    onRetryMessage?: (id: string) => void
    onDismissFailedMessage?: (id: string) => void
    onReadThrough?: (id: string) => void
    unreadBoundaryMessageId?: string | null
    canModerate?: boolean
  } = {}
): void {
  container ??= document.createElement('div')
  if (!container.parentElement) {
    document.body.appendChild(container)
  }
  root ??= createRoot(container)
  act(() => {
    root?.render(
      <TooltipProvider>
        <MessageTimeline
          messages={messages}
          currentUserId={USER}
          members={[member(USER, 'Ada'), member(OTHER, 'Grace')]}
          loading={false}
          channelId={CHANNEL}
          canModerate={callbacks.canModerate}
          onToggleReaction={vi.fn()}
          onOpenThread={vi.fn()}
          onTogglePin={vi.fn()}
          onEditMessage={vi.fn()}
          onDeleteMessage={vi.fn()}
          onRetryMessage={callbacks.onRetryMessage}
          onDismissFailedMessage={callbacks.onDismissFailedMessage}
          onReadThrough={callbacks.onReadThrough}
          unreadBoundaryMessageId={callbacks.unreadBoundaryMessageId}
          loadingOlder={false}
          hasOlder={false}
          onLoadOlder={vi.fn()}
          focusedMessageId={null}
        />
      </TooltipProvider>
    )
  })
}

beforeEach(() => {
  scrollIntoView.mockReset()
  Element.prototype.scrollIntoView = scrollIntoView
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('MessageTimeline scrolling', () => {
  it('scrolls only its viewport when a new message arrives', () => {
    renderTimeline()
    const viewport = container?.querySelector(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLDivElement
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 480 })

    renderTimeline([
      message(),
      message({ id: '20000000-0000-4000-8000-000000000011', body: 'new message' })
    ])

    expect(viewport.scrollTop).toBe(480)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('keeps the viewport in place and offers a jump when messages arrive above the bottom', () => {
    const first = message()
    renderTimeline([first])
    const viewport = container?.querySelector(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLDivElement
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 }
    })
    viewport.scrollTop = 100
    act(() => viewport.dispatchEvent(new Event('scroll')))

    renderTimeline([
      first,
      message({ id: '20000000-0000-4000-8000-000000000011', body: 'new message' })
    ])

    expect(viewport.scrollTop).toBe(100)
    expect(container?.textContent).toContain('New messages')
  })

  it('renders the unread divider at the captured boundary', () => {
    const boundary = '20000000-0000-4000-8000-000000000011'
    renderTimeline([message(), message({ id: boundary })], { unreadBoundaryMessageId: boundary })

    expect(container?.querySelector('[aria-label="Unread messages"]')).not.toBeNull()
  })
})

describe('MessageTimeline delivery state', () => {
  it('offers retry and dismiss actions for a failed optimistic message', () => {
    const onRetryMessage = vi.fn()
    const onDismissFailedMessage = vi.fn()
    const optimisticId = '20000000-0000-4000-8000-000000000099'
    renderTimeline([message({ id: optimisticId, optimisticId, pending: false, failed: true })], {
      onRetryMessage,
      onDismissFailedMessage
    })

    const buttons = Array.from(container?.querySelectorAll('button') ?? [])
    act(() =>
      buttons
        .find((button) => button.textContent === 'Retry')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    act(() =>
      buttons
        .find((button) => button.textContent === 'Dismiss')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )

    expect(onRetryMessage).toHaveBeenCalledWith(optimisticId)
    expect(onDismissFailedMessage).toHaveBeenCalledWith(optimisticId)
  })
})

describe('MessageTimeline moderation', () => {
  it('shows delete for another user only to a channel moderator', () => {
    renderTimeline([message({ authorId: OTHER })])
    expect(container?.querySelector('button[aria-label="Delete"]')).toBeNull()

    renderTimeline([message({ authorId: OTHER })], { canModerate: true })
    expect(container?.querySelector('button[aria-label="Delete"]')).not.toBeNull()
  })
})
