// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationInbox } from './NotificationInbox'
import { channel, notification } from './chat-test-fixtures'

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

describe('NotificationInbox', () => {
  it('renders a real notification with an unread dot', () => {
    render(
      <NotificationInbox
        notifications={[notification()]}
        channels={[channel({ name: 'general' })]}
        unreadCount={1}
        onSelect={vi.fn()}
        onMarkAllRead={vi.fn()}
      />
    )
    expect(container?.textContent).toContain('Mentioned you in #general')
    expect(container?.querySelector('[data-unread="true"]')).not.toBeNull()
  })

  it('calls onMarkAllRead when the mark-all action is clicked', () => {
    const onMarkAllRead = vi.fn()
    render(
      <NotificationInbox
        notifications={[notification()]}
        channels={[channel()]}
        unreadCount={1}
        onSelect={vi.fn()}
        onMarkAllRead={onMarkAllRead}
      />
    )
    const button = Array.from(container?.querySelectorAll('button') ?? []).find(
      (element) => element.textContent === 'Mark all read'
    )
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onMarkAllRead).toHaveBeenCalledOnce()
  })

  it('selects a notification on click and hides the dot when read', () => {
    const onSelect = vi.fn()
    render(
      <NotificationInbox
        notifications={[notification({ read: true, seen: true })]}
        channels={[channel({ name: 'general' })]}
        unreadCount={0}
        onSelect={onSelect}
        onMarkAllRead={vi.fn()}
      />
    )
    // A read row shows no unread dot and no mark-all action.
    expect(container?.querySelector('[data-unread="true"]')).toBeNull()
    const row = container?.querySelector('ul button') as HTMLButtonElement
    act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('keeps the honest empty state when there are no notifications', () => {
    render(
      <NotificationInbox
        notifications={[]}
        channels={[]}
        unreadCount={0}
        onSelect={vi.fn()}
        onMarkAllRead={vi.fn()}
      />
    )
    expect(container?.textContent).toContain('No new notifications')
  })
})
