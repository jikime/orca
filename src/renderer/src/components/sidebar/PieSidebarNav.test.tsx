// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/pie/workspace/pie-domain-registry', () => ({
  buildPieCommunicationDomains: () => [{ key: 'meetings', label: 'Meetings' }],
  buildPieCustomerDomains: () => [{ key: 'accounts', label: 'Accounts' }],
  buildPieSupportDomains: () => [{ key: 'tickets', label: 'Tickets' }],
  buildPieAdminDomains: () => [{ key: 'ai-entitlements', label: 'AI Entitlements' }]
}))

import { PieSidebarNav } from './PieSidebarNav'
import { getPieWorkspaceRoute, setPieWorkspaceRoute } from '@/pie/workspace/pie-workspace-route'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => setPieWorkspaceRoute('chat'))

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  setPieWorkspaceRoute('chat')
})

describe('PieSidebarNav', () => {
  it('shows Pie modules in the outer sidebar and changes the shared route', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<PieSidebarNav />))

    expect(container.textContent).toContain('Chat')
    expect(container.textContent).toContain('Meetings')
    expect(container.textContent).toContain('My Work')
    expect(container.textContent).toContain('Projects')
    expect(container.textContent).toContain('Accounts')
    expect(container.textContent).toContain('Tickets')

    const projects = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Projects'
    )
    act(() => projects?.click())

    expect(getPieWorkspaceRoute()).toBe('projects')
    expect(projects?.getAttribute('aria-current')).toBe('page')
  })
})
