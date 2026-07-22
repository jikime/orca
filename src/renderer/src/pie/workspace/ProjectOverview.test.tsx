// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectResource } from './project-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const conversation = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock('./pie-resource-conversation', () => ({
  openPieResourceConversation: conversation.open
}))

vi.mock('../control-plane/use-pie-resource', () => ({
  usePieResource: (path: string) => {
    const data = path.startsWith('/work-items')
      ? {
          items: [
            { id: 'work-1', priority: 'high', assigneeId: null },
            { id: 'work-2', priority: 'normal', assigneeId: 'user-1' }
          ]
        }
      : path.endsWith('/change-requests')
        ? {
            items: [
              { id: 'change-1', status: 'draft' },
              { id: 'change-2', status: 'applied' }
            ]
          }
        : path.endsWith('/deliverables')
          ? {
              items: [
                { id: 'deliverable-1', status: 'accepted' },
                { id: 'deliverable-2', status: 'in_review' }
              ]
            }
          : path.endsWith('/defects')
            ? {
                items: [
                  { id: 'defect-1', status: 'open' },
                  { id: 'defect-2', status: 'closed' }
                ]
              }
            : {
                projectId: 'project-1',
                openRisksBySeverity: { low: 0, medium: 0, high: 1, critical: 1 },
                openRiskCount: 2,
                latestStatusReport: {
                  id: 'report-1',
                  periodEnd: '2026-07-21',
                  overallStatus: 'amber',
                  summary: 'Delivery is on track.'
                },
                recentDecisions: [
                  {
                    id: 'decision-1',
                    title: 'Keep the current scope',
                    decision: 'Approved',
                    decidedAt: '2026-07-21T00:00:00.000Z'
                  }
                ]
              }
    return { data, loading: false, error: null, refetch: vi.fn() }
  }
}))

import { ProjectOverview } from './ProjectOverview'

const PROJECT: ProjectResource = {
  id: 'project-1',
  organizationId: 'organization-1',
  name: 'Orca',
  summary: 'Desktop work',
  status: 'active',
  version: 1,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
  archivedAt: null
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(
  overrides: {
    onEdit?: () => void
    onOpenDelivery?: (key: 'change-requests' | 'deliverables' | 'defects') => void
  } = {}
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root?.render(
      <ProjectOverview
        project={PROJECT}
        onEdit={overrides.onEdit ?? vi.fn()}
        onOpenWork={vi.fn()}
        onOpenDelivery={overrides.onOpenDelivery ?? vi.fn()}
        onOpenManagement={vi.fn()}
      />
    )
  )
  return container
}

function click(view: HTMLDivElement, label: string): void {
  const button = [...view.querySelectorAll('button')].find((item) => item.textContent === label)
  act(() => button?.click())
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  vi.clearAllMocks()
})

describe('ProjectOverview', () => {
  it('shows selected-project delivery and governance signals', () => {
    const view = render()

    expect(view.textContent).toContain('Orca')
    expect(view.textContent).toContain('1 unassigned · 1 high priority')
    expect(view.textContent).toContain('2 total defects')
    expect(view.textContent).toContain('Delivery is on track.')
    expect(view.textContent).toContain('Keep the current scope')
  })

  it('routes overview actions to project editing and the requested domain', () => {
    const onEdit = vi.fn()
    const onOpenDelivery = vi.fn()
    const view = render({ onEdit, onOpenDelivery })

    click(view, 'Edit project')
    click(view, 'Open change requests')

    expect(onEdit).toHaveBeenCalledOnce()
    expect(onOpenDelivery).toHaveBeenCalledWith('change-requests')
  })

  it('opens the selected project conversation', async () => {
    conversation.open.mockResolvedValue(undefined)
    const view = render()

    const button = [...view.querySelectorAll('button')].find(
      (item) => item.textContent === 'Open conversation'
    )
    await act(async () => button?.click())

    expect(conversation.open).toHaveBeenCalledWith({
      scopeType: 'project',
      resourceId: PROJECT.id,
      label: PROJECT.name
    })
  })
})
