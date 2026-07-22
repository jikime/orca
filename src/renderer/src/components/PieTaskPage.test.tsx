// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openTaskPage: vi.fn(),
  closeTaskPage: vi.fn(),
  updateSettings: vi.fn(() => Promise.resolve()),
  state: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => ({}),
  localPreflightContextKey: () => 'local'
}))

vi.mock('@/pie/workspace/WorkItemBoard', () => ({
  WorkItemBoard: ({ scope }: { scope: string }) => <div data-testid="work-items">{scope}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./task-page-localized-options', () => ({
  getSourceOptions: () => [
    { id: 'github', label: 'GitHub', Icon: () => <span /> },
    { id: 'linear', label: 'Linear', Icon: () => <span /> }
  ]
}))

import PieTaskPage from './PieTaskPage'

const roots: Root[] = []

async function renderPage(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(<PieTaskPage />))
  return container
}

beforeEach(() => {
  mocks.openTaskPage.mockReset()
  mocks.closeTaskPage.mockReset()
  mocks.updateSettings.mockClear()
  mocks.state = {
    settings: {
      visibleTaskProviders: ['github', 'linear'],
      defaultTaskSource: 'github'
    },
    repos: [],
    preflightStatus: { glab: { installed: false } },
    preflightStatusContextKey: 'local',
    linearStatus: { connected: true },
    openTaskPage: mocks.openTaskPage,
    closeTaskPage: mocks.closeTaskPage,
    updateSettings: mocks.updateSettings
  }
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

describe('PieTaskPage', () => {
  it('browses assigned Pie work without a repository and keeps account sources available', async () => {
    const container = await renderPage()
    const pieSource = container.querySelector<HTMLButtonElement>('[data-task-source="pie"]')
    const githubSource = container.querySelector<HTMLButtonElement>('[data-task-source="github"]')
    const linearSource = container.querySelector<HTMLButtonElement>('[data-task-source="linear"]')

    expect(container.querySelector('[data-testid="work-items"]')?.textContent).toBe('mine')
    expect(pieSource?.getAttribute('aria-pressed')).toBe('true')
    expect(githubSource?.disabled).toBe(true)
    expect(linearSource?.disabled).toBe(false)

    await act(async () => linearSource?.click())
    expect(mocks.openTaskPage).toHaveBeenCalledWith(
      { taskSource: 'linear' },
      { recordTasksInteraction: false }
    )
  })
})
