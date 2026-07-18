// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextSidebar } from './ContextSidebar'
import { channel, member, notification } from './chat-test-fixtures'

const ALICE = '20000000-0000-4000-8000-0000000000a1'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(node: React.JSX.Element): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('ContextSidebar', () => {
  it('renders the member roster and a real notification with its channel', () => {
    render(
      <ContextSidebar
        members={[member(ALICE, 'alice')]}
        channels={[channel({ name: 'general' })]}
        notifications={[notification()]}
        unreadNotificationCount={1}
        onSelectNotification={vi.fn()}
        onMarkAllNotificationsRead={vi.fn()}
      />
    )

    expect(container?.textContent).toContain('Members · 1')
    expect(container?.textContent).toContain('alice')
    expect(container?.textContent).toContain('Mentioned you in #general')
  })

  it('shows an honest empty state when the feed is empty', () => {
    render(
      <ContextSidebar
        members={[]}
        channels={[]}
        notifications={[]}
        unreadNotificationCount={0}
        onSelectNotification={vi.fn()}
        onMarkAllNotificationsRead={vi.fn()}
      />
    )

    expect(container?.textContent).toContain('No new notifications')
  })
})
