// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const WORK_ITEM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const mocks = vi.hoisted(() => ({
  state: {
    getKnownWorktreeById: (id: string) =>
      id === 'worktree-1'
        ? {
            pieWorkspaceContext: {
              schemaVersion: 1 as const,
              authority: 'pie' as const,
              organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              projectName: 'Orca desktop',
              workItemId: WORK_ITEM_ID,
              workItemIdentifier: 'APP-142',
              workItemTitle: 'Fix login error'
            }
          }
        : undefined,
    setActiveView: vi.fn()
  }
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
  return { useAppStore }
})

import { PieWorkspaceContextBar } from './PieWorkspaceContextBar'
import { takePieWorkItemNavigation } from './pie-work-item-navigation'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  takePieWorkItemNavigation()
  vi.clearAllMocks()
})

describe('PieWorkspaceContextBar', () => {
  it('shows the project and work item, then returns to the same opaque item', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<PieWorkspaceContextBar worktreeId="worktree-1" />))

    expect(container.textContent).toContain('Orca desktop')
    expect(container.textContent).toContain('APP-142')

    const button = container.querySelector('button')
    act(() => button?.click())

    expect(mocks.state.setActiveView).toHaveBeenCalledWith('pie')
    expect(takePieWorkItemNavigation()).toEqual({
      workItemId: WORK_ITEM_ID,
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })
  })

  it('does not reserve terminal space for an unlinked workspace', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<PieWorkspaceContextBar worktreeId="worktree-2" />))

    expect(container.childElementCount).toBe(0)
  })
})
