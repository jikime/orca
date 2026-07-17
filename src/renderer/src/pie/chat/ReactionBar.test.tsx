// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactionBar } from './ReactionBar'
import type { PieMessageReaction } from '../../../../shared/pie-chat-contract'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(reactions: PieMessageReaction[], onToggle: (emoji: string) => void): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<ReactionBar reactions={reactions} onToggle={onToggle} />)
  })
}

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

describe('ReactionBar', () => {
  it('renders each reaction emoji with its count', () => {
    render(
      [
        { emoji: '👍', count: 3, reactedByMe: true },
        { emoji: '🎉', count: 1, reactedByMe: false }
      ],
      vi.fn()
    )
    expect(container?.textContent).toContain('👍')
    expect(container?.textContent).toContain('3')
    expect(container?.textContent).toContain('🎉')
  })

  it('marks a reaction the viewer made as pressed', () => {
    render([{ emoji: '👍', count: 3, reactedByMe: true }], vi.fn())
    const pressed = container?.querySelector('button[aria-pressed="true"]')
    expect(pressed?.textContent).toContain('👍')
  })

  it('calls onToggle with the emoji when an existing reaction is clicked', () => {
    const onToggle = vi.fn()
    render([{ emoji: '👍', count: 3, reactedByMe: true }], onToggle)
    const button = Array.from(container?.querySelectorAll('button') ?? []).find(
      (element) => element.getAttribute('aria-pressed') !== null
    )
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onToggle).toHaveBeenCalledWith('👍')
  })
})
