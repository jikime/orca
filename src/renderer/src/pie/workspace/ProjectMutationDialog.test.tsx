// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectResource } from './project-types'

const api = vi.hoisted(() => ({
  patch: vi.fn(),
  post: vi.fn()
}))

vi.mock('../control-plane/pie-api-client', () => ({
  apiPatch: api.patch,
  apiPost: api.post,
  resourceEtag: (prefix: string, version: number) => `"${prefix}-${version}"`
}))

vi.mock('./PieResourceMutationDialog', () => ({
  PieResourceMutationDialog: ({
    mode,
    onSubmit
  }: {
    mode: string
    onSubmit: (body: Record<string, unknown>) => Promise<void>
  }) => (
    <button
      type="button"
      onClick={() =>
        void onSubmit({ name: 'Updated project', status: 'active', summary: 'Summary' })
      }
    >
      {mode}
    </button>
  )
}))

import { ProjectMutationDialog } from './ProjectMutationDialog'

const PROJECT: ProjectResource = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Orca',
  summary: null,
  status: 'planned',
  version: 4,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
  archivedAt: null
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(project: ProjectResource | null, onSaved: (value: ProjectResource) => void): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root?.render(
      <ProjectMutationDialog open project={project} onOpenChange={vi.fn()} onSaved={onSaved} />
    )
  )
}

async function submit(): Promise<void> {
  await act(async () => {
    container?.querySelector('button')?.click()
  })
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

describe('ProjectMutationDialog', () => {
  it('creates a project and returns the saved resource', async () => {
    const saved = { ...PROJECT, name: 'Updated project' }
    const onSaved = vi.fn()
    api.post.mockResolvedValue(saved)
    render(null, onSaved)

    await submit()

    expect(api.post).toHaveBeenCalledWith('/projects', {
      name: 'Updated project',
      status: 'active',
      summary: 'Summary'
    })
    expect(onSaved).toHaveBeenCalledWith(saved)
  })

  it('updates a project with its optimistic-concurrency version', async () => {
    const saved = { ...PROJECT, name: 'Updated project', version: 5 }
    api.patch.mockResolvedValue(saved)
    render(PROJECT, vi.fn())

    await submit()

    expect(api.patch).toHaveBeenCalledWith(
      `/projects/${PROJECT.id}`,
      { name: 'Updated project', status: 'active', summary: 'Summary' },
      '"project-4"'
    )
  })
})
