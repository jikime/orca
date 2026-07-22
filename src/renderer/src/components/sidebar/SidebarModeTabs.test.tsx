// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TopLevelView } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  state: {} as { activeView: TopLevelView; setActiveView: (view: TopLevelView) => void },
  setActiveView: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

import { SidebarModeTabs } from './SidebarModeTabs'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(activeView: TopLevelView): HTMLDivElement {
  mocks.state = { activeView, setActiveView: mocks.setActiveView }
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root?.render(<SidebarModeTabs />))
  return container
}

function tab(view: ParentNode, label: string): HTMLButtonElement {
  const match = [...view.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent === label
  )
  if (!match) {
    throw new Error(`Missing sidebar tab: ${label}`)
  }
  return match
}

function selectTab(button: HTMLButtonElement): void {
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  vi.clearAllMocks()
})

describe('SidebarModeTabs', () => {
  it('opens Pie and returns to the last Orca view', () => {
    const view = render('tasks')

    act(() => selectTab(tab(view, 'Pie')))
    expect(mocks.setActiveView).toHaveBeenLastCalledWith('pie')

    render('pie')
    act(() => selectTab(tab(view, 'Orca')))
    expect(mocks.setActiveView).toHaveBeenLastCalledWith('tasks')
  })

  it('falls back to the terminal when Pie was restored at startup', () => {
    const view = render('pie')

    act(() => selectTab(tab(view, 'Orca')))

    expect(mocks.setActiveView).toHaveBeenCalledWith('terminal')
  })
})
