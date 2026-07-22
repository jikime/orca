// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../chat/ChatScreen', () => ({ ChatScreen: () => <div>chat-screen</div> }))
vi.mock('../meetings/MeetingWorkspace', () => ({
  MeetingWorkspace: () => <div>meeting-screen</div>
}))
vi.mock('./ProjectWorkspace', () => ({
  ProjectWorkspace: () => <div>project-screen</div>
}))
vi.mock('./WorkItemBoard', () => ({
  WorkItemBoard: ({ scope }: { scope?: string }) => <div>work-screen:{scope}</div>
}))
vi.mock('./PieResourceScreen', () => ({
  PieResourceScreen: ({ config }: { config: { key: string } }) => (
    <div>resource-screen:{config.key}</div>
  )
}))
vi.mock('./pie-domain-registry', () => ({
  buildPieCommunicationDomains: () => [{ key: 'meetings' }],
  buildPieCustomerDomains: () => [{ key: 'accounts' }],
  buildPieSupportDomains: () => [],
  buildPieAdminDomains: () => []
}))

import { PieWorkspace } from './PieWorkspace'
import { setPieWorkspaceRoute } from './pie-workspace-route'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<PieWorkspace />))
  return container
}

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

describe('PieWorkspace content routing', () => {
  it('renders content without the former nested module navigation', () => {
    const view = render()

    expect(view.textContent).toBe('chat-screen')
    expect(view.querySelector('nav')).toBeNull()
  })

  it('switches between meetings and project content from the shared route', () => {
    const view = render()

    act(() => setPieWorkspaceRoute('meetings'))
    expect(view.textContent).toBe('meeting-screen')

    act(() => setPieWorkspaceRoute('projects'))
    expect(view.textContent).toBe('project-screen')
  })

  it('keeps My Work filtered while direct work-item navigation stays unfiltered', () => {
    const view = render()

    act(() => setPieWorkspaceRoute('my-work'))
    expect(view.textContent).toBe('work-screen:mine')

    act(() => setPieWorkspaceRoute('work-item'))
    expect(view.textContent).toBe('work-screen:')
  })

  it('renders declarative Pie resources selected in the app sidebar', () => {
    const view = render()

    act(() => setPieWorkspaceRoute('accounts'))

    expect(view.textContent).toBe('resource-screen:accounts')
  })
})
