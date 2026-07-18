// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MemberRoster } from './MemberRoster'
import { member } from './chat-test-fixtures'

const ALICE = '20000000-0000-4000-8000-0000000000a1'
const BOB = '20000000-0000-4000-8000-0000000000b2'

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

describe('MemberRoster', () => {
  it('renders every member with a header count', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <MemberRoster
          members={[member(ALICE, 'alice'), member(BOB, 'bob')]}
          onlineUserIds={new Set([ALICE])}
        />
      )
    })

    // Header shows online / total, and only the online member reads "online".
    expect(container?.textContent).toContain('Members · 1/2 online')
    expect(container?.textContent).toContain('alice')
    expect(container?.textContent).toContain('bob')
    expect(container?.textContent).toContain('online')
    expect(container?.textContent).toContain('offline')
  })

  it('renders an empty state with no members', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(<MemberRoster members={[]} onlineUserIds={new Set()} />)
    })

    expect(container?.textContent).toContain('Members · 0/0 online')
    expect(container?.textContent).toContain('No members found')
  })
})
