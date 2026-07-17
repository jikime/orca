// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageAvatar } from './MessageAvatar'

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

function mount(node: React.JSX.Element): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(node)
  })
}

describe('MessageAvatar', () => {
  it('renders the first two letters of the label as initials', () => {
    mount(<MessageAvatar label="alice" />)
    expect(container?.textContent).toBe('AL')
  })

  it('renders a single Y for the current user label', () => {
    mount(<MessageAvatar label="You" />)
    expect(container?.textContent).toBe('Y')
  })
})
