// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageActionToolbar } from './MessageActionToolbar'

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderToolbar(overrides: { pinned?: boolean } = {}): {
  onReact: ReturnType<typeof vi.fn>
  onReply: ReturnType<typeof vi.fn>
  onTogglePin: ReturnType<typeof vi.fn>
  onEdit: ReturnType<typeof vi.fn>
  onDelete: ReturnType<typeof vi.fn>
  onCreateWorkItem: ReturnType<typeof vi.fn>
  onAddToAgenda: ReturnType<typeof vi.fn>
} {
  const callbacks = {
    onReact: vi.fn(),
    onReply: vi.fn(),
    onTogglePin: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onCreateWorkItem: vi.fn(),
    onAddToAgenda: vi.fn()
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <TooltipProvider>
        <div className="group/message relative">
          <MessageActionToolbar {...callbacks} pinned={overrides.pinned} />
        </div>
      </TooltipProvider>
    )
  })
  return callbacks
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  document.body.innerHTML = ''
  root = null
  container = null
})

describe('MessageActionToolbar', () => {
  it('anchors a compact icon toolbar to the right edge of its message row', () => {
    renderToolbar()

    const toolbar = container?.querySelector('[data-slot="message-action-toolbar"]')
    expect(toolbar?.className).toContain('can-hover:absolute')
    expect(toolbar?.className).toContain('can-hover:right-2')
    expect(toolbar?.className).toContain('can-hover:opacity-0')
    expect(toolbar?.className).toContain('group-hover/message:opacity-100')

    expect(container?.querySelector('button[aria-label="React"]')).not.toBeNull()
    expect(container?.querySelector('button[aria-label="Reply"]')).not.toBeNull()
    expect(container?.querySelector('button[aria-label="Pin"]')).not.toBeNull()
    expect(container?.querySelector('button[aria-label="Work item"]')).not.toBeNull()
    expect(container?.querySelector('button[aria-label="Add to agenda"]')).not.toBeNull()
    expect(container?.querySelector('button[aria-label="Edit"]')).not.toBeNull()
    expect(container?.querySelector('button[aria-label="Delete"]')).not.toBeNull()
  })

  it('runs reply, pin, edit, and delete from the icon actions', () => {
    const callbacks = renderToolbar()

    act(() => {
      fireEvent.click(container?.querySelector('button[aria-label="Reply"]') as Element)
      fireEvent.click(container?.querySelector('button[aria-label="Pin"]') as Element)
      fireEvent.click(container?.querySelector('button[aria-label="Work item"]') as Element)
      fireEvent.click(container?.querySelector('button[aria-label="Add to agenda"]') as Element)
      fireEvent.click(container?.querySelector('button[aria-label="Edit"]') as Element)
      fireEvent.click(container?.querySelector('button[aria-label="Delete"]') as Element)
    })

    expect(callbacks.onReply).toHaveBeenCalledOnce()
    expect(callbacks.onTogglePin).toHaveBeenCalledOnce()
    expect(callbacks.onCreateWorkItem).toHaveBeenCalledOnce()
    expect(callbacks.onAddToAgenda).toHaveBeenCalledOnce()
    expect(callbacks.onEdit).toHaveBeenCalledOnce()
    expect(callbacks.onDelete).toHaveBeenCalledOnce()
  })

  it('opens the quick reaction picker and returns the selected emoji', () => {
    const callbacks = renderToolbar()

    act(() => {
      fireEvent.click(container?.querySelector('button[aria-label="React"]') as Element)
    })
    const celebration = document.body.querySelector('button[aria-label="React 🎉"]')
    expect(celebration).not.toBeNull()

    act(() => {
      fireEvent.click(celebration as Element)
    })
    expect(callbacks.onReact).toHaveBeenCalledWith('🎉')
  })

  it('shows the unpin state for a pinned message', () => {
    renderToolbar({ pinned: true })

    const button = container?.querySelector('button[aria-label="Unpin"]')
    expect(button?.getAttribute('aria-pressed')).toBe('true')
  })
})
