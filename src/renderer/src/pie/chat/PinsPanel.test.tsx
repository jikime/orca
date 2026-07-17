// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The popover is gated on an internal `open` state that drives the pins fetch;
// this mock exposes the trigger's onOpenChange so a click can open it in the test.
const openHolder = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    openHolder.onOpenChange = onOpenChange
    return <div>{children}</div>
  },
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div onClick={() => openHolder.onOpenChange?.(true)}>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

import { PinsPanel } from './PinsPanel'
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
  openHolder.onOpenChange = undefined
})

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

function renderPins(
  api: ReturnType<typeof makeChatApi>,
  onJump: (messageId: string) => void
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<PinsPanel channelId={CHANNEL} api={api} onJumpToMessage={onJump} />)
  })
}

function openPanel(): void {
  const trigger = container?.querySelector('[aria-label="Pinned messages"]')
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('PinsPanel', () => {
  it('fetches and lists pinned messages when opened', async () => {
    const listPins = vi.fn().mockResolvedValue([pinnedMessage(message({ body: 'pinned note' }))])
    const api = makeChatApi({ listPins })
    renderPins(api, vi.fn())

    openPanel()
    await flush()

    expect(listPins).toHaveBeenCalledWith(CHANNEL)
    expect(container?.textContent).toContain('pinned note')
  })

  it('jumps to a message when a pin is clicked', async () => {
    const pinned = pinnedMessage(message({ body: 'pinned note' }))
    const api = makeChatApi({ listPins: vi.fn().mockResolvedValue([pinned]) })
    const onJump = vi.fn()
    renderPins(api, onJump)

    openPanel()
    await flush()

    const pinButton = Array.from(container?.querySelectorAll('button') ?? []).find((element) =>
      element.textContent?.includes('pinned note')
    )
    act(() => {
      pinButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onJump).toHaveBeenCalledWith(pinned.message.id)
  })
})
