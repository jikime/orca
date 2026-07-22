// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => (
    <div
      data-mock-panel-root="popover"
      onClickCapture={(event) => {
        if ((event.target as Element).closest('[data-mock-panel-trigger]')) {
          onOpenChange?.(true)
        }
      }}
    >
      {children}
    </div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) =>
    React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
      'data-mock-panel-trigger': true
    }),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-mock-panel-content>{children}</div>
  )
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

import { ChatHeaderContextControls } from './ChatHeaderContextControls'
import {
  CHANNEL,
  OTHER,
  channel,
  flush,
  makeChatApi,
  member,
  notification
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

describe('ChatHeaderContextControls', () => {
  it('provides popover and sheet surfaces and loads the channel roster', async () => {
    const listChannelMembers = vi
      .fn()
      .mockResolvedValue([{ userId: OTHER, role: 'member', addedAt: '2026-07-16T00:00:00.000Z' }])
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <ChatHeaderContextControls
          channel={channel()}
          channels={[channel()]}
          members={[member(OTHER, 'b Tester')]}
          onlineUserIds={new Set([OTHER])}
          notifications={[notification()]}
          unreadNotificationCount={1}
          api={makeChatApi({ listChannelMembers })}
          onSelectNotification={vi.fn()}
          onMarkAllNotificationsRead={vi.fn()}
        />
      )
    })

    expect(container.querySelectorAll('[data-chat-header-panel="popover"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-chat-header-panel="sheet"]')).toHaveLength(2)
    const trigger = container.querySelector(
      '[data-chat-header-panel="popover"] button[aria-label="Open channel members"]'
    ) as HTMLButtonElement
    act(() => trigger.click())
    await flush()

    expect(listChannelMembers).toHaveBeenCalledWith(CHANNEL)
    expect(container.textContent).toContain('b Tester')
    expect(container.textContent).toContain('1/1 online')
  })

  it('shows the unread badge and forwards a selected notification', () => {
    const onSelectNotification = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <ChatHeaderContextControls
          channel={channel()}
          channels={[channel()]}
          members={[]}
          onlineUserIds={new Set()}
          notifications={[notification()]}
          unreadNotificationCount={1}
          api={makeChatApi()}
          onSelectNotification={onSelectNotification}
          onMarkAllNotificationsRead={vi.fn()}
        />
      )
    })

    const trigger = container.querySelector(
      '[data-chat-header-panel="popover"] button[aria-label="Open notifications"]'
    ) as HTMLButtonElement
    expect(trigger.textContent).toContain('1')
    const row = [...container.querySelectorAll('[data-mock-panel-content] button')].find((button) =>
      button.textContent?.includes('Mentioned you')
    ) as HTMLButtonElement
    act(() => row.click())

    expect(onSelectNotification).toHaveBeenCalledWith(notification())
  })
})
