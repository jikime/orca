// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextSidebar } from './ContextSidebar'
import { OTHER, USER, member, message } from './chat-test-fixtures'

const ALICE = '20000000-0000-4000-8000-0000000000a1'

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

describe('ContextSidebar', () => {
  it('renders the member roster and a mention-derived notification', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <ContextSidebar
          members={[member(ALICE, 'alice')]}
          messages={[message({ authorId: OTHER, body: 'hey @Pie User can you look at this' })]}
          currentUserId={USER}
          currentUserDisplayName="Pie User"
        />
      )
    })

    expect(container?.textContent).toContain('Members · 1')
    expect(container?.textContent).toContain('alice')
    expect(container?.textContent).toContain('mentioned you')
  })

  it('shows an honest empty state when nothing mentions the current user', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <ContextSidebar
          members={[]}
          messages={[message({ authorId: OTHER, body: 'unrelated message' })]}
          currentUserId={USER}
          currentUserDisplayName="Pie User"
        />
      )
    })

    expect(container?.textContent).toContain('No new notifications')
  })
})
