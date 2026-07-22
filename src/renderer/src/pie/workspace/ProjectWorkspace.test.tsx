// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

vi.mock('../control-plane/use-pie-resource', () => ({
  usePieResource: () => ({
    data: {
      items: [
        {
          id: PROJECT_ID,
          organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name: 'Orca',
          summary: 'Desktop work',
          status: 'active',
          version: 1,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-21T00:00:00.000Z',
          archivedAt: null
        }
      ]
    },
    loading: false,
    error: null,
    refetch: vi.fn()
  })
}))

vi.mock('./ProjectOverview', () => ({
  ProjectOverview: ({
    project,
    onEdit,
    onOpenDelivery
  }: {
    project: { name: string }
    onEdit: () => void
    onOpenDelivery: (key: 'change-requests') => void
  }) => (
    <div>
      {`overview:${project.name}`}
      <button type="button" onClick={onEdit}>
        Edit project
      </button>
      <button type="button" onClick={() => onOpenDelivery('change-requests')}>
        Overview changes
      </button>
    </div>
  )
}))

vi.mock('./ProjectMutationDialog', () => ({
  ProjectMutationDialog: ({ open, project }: { open: boolean; project: unknown }) => (
    <div>{`project-dialog:${open ? 'open' : 'closed'}:${project ? 'edit' : 'create'}`}</div>
  )
}))

vi.mock('./PieResourceScreen', () => ({
  PieResourceScreen: ({
    config,
    fixedProjectId
  }: {
    config: { key: string }
    fixedProjectId?: string
  }) => <div>{`resource:${config.key}:${fixedProjectId ?? 'none'}`}</div>
}))

vi.mock('./WorkItemBoard', () => ({
  WorkItemBoard: ({
    fixedProjectId,
    initialSelectedId
  }: {
    fixedProjectId?: string
    initialSelectedId?: string | null
  }) => <div>{`work:${fixedProjectId ?? 'none'}:${initialSelectedId ?? 'none'}`}</div>
}))

vi.mock('./pie-domain-registry', () => ({
  buildPiePortalDomains: () =>
    [
      ['projects', 'Projects', 'org'],
      ['change-requests', 'Change Requests', 'project'],
      ['deliverables', 'Deliverables', 'project'],
      ['defects', 'Defects', 'project'],
      ['risks', 'Risks', 'project'],
      ['decisions', 'Decisions', 'project'],
      ['status-reports', 'Status Reports', 'project']
    ].map(([key, label, scope]) => ({
      key,
      label,
      scope,
      listPath: `/${key}`,
      itemPath: (id: string) => `/${key}/${id}`,
      etagPrefix: key,
      columns: []
    }))
}))

import { ProjectWorkspace } from './ProjectWorkspace'
import { queuePieWorkItemNavigation, takePieWorkItemNavigation } from './pie-work-item-navigation'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<ProjectWorkspace />))
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
  takePieWorkItemNavigation()
})

describe('ProjectWorkspace', () => {
  it('keeps project operations inside one project surface', () => {
    const view = render()
    expect(view.textContent).toContain('overview:Orca')

    click(view, 'Work')
    expect(view.textContent).toContain(`work:${PROJECT_ID}:none`)

    click(view, 'Delivery & Quality')
    expect(view.textContent).toContain(`resource:change-requests:${PROJECT_ID}`)

    click(view, 'Management')
    expect(view.textContent).toContain(`resource:risks:${PROJECT_ID}`)
  })

  it('opens project creation and editing as dialogs', () => {
    const view = render()

    click(view, 'New project')
    expect(view.textContent).toContain('project-dialog:open:create')

    click(view, 'Edit project')
    expect(view.textContent).toContain('project-dialog:open:edit')
  })

  it('navigates from overview metrics into the selected project domain', () => {
    const view = render()

    click(view, 'Overview changes')

    expect(view.textContent).toContain(`resource:change-requests:${PROJECT_ID}`)
  })

  it('returns a workspace-linked item to its project Work tab', () => {
    queuePieWorkItemNavigation({ workItemId: 'work-item-1', projectId: PROJECT_ID })

    const view = render()

    expect(view.textContent).toContain(`work:${PROJECT_ID}:work-item-1`)
  })
})
