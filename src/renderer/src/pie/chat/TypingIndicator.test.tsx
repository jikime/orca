// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TypingIndicator } from './TypingIndicator'
import { member, USER, OTHER } from './chat-test-fixtures'

const THIRD = '10000000-0000-4000-8000-000000000003'

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

const members = [member(USER, 'Ada'), member(OTHER, 'Bianca'), member(THIRD, 'Carlos')]

describe('TypingIndicator', () => {
  it('names a single typist', () => {
    render(<TypingIndicator typingUserIds={[OTHER]} members={members} />)
    expect(container?.textContent).toBe('Bianca is typing…')
  })

  it('names two typists', () => {
    render(<TypingIndicator typingUserIds={[OTHER, THIRD]} members={members} />)
    expect(container?.textContent).toBe('Bianca and Carlos are typing…')
  })

  it('summarizes three or more typists', () => {
    render(<TypingIndicator typingUserIds={[USER, OTHER, THIRD]} members={members} />)
    expect(container?.textContent).toBe('3 people are typing…')
  })

  it('renders nothing (empty row) when no one is typing', () => {
    render(<TypingIndicator typingUserIds={[]} members={members} />)
    expect(container?.textContent).toBe('')
  })
})
