// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageWorkItemDialog } from './MessageWorkItemDialog'
import { message } from './chat-test-fixtures'
import { apiGet, apiPostWithIdempotencyKey } from '../control-plane/pie-api-client'
import { takePieWorkItemNavigation } from '../workspace/pie-work-item-navigation'
import { getPieWorkspaceRoute, setPieWorkspaceRoute } from '../workspace/pie-workspace-route'

vi.mock('../control-plane/pie-api-client', () => ({
  apiGet: vi.fn(),
  apiPostWithIdempotencyKey: vi.fn(),
  PieApiError: class PieApiError extends Error {}
}))

const TEAM = '20000000-0000-4000-8000-000000000071'
const WORK_ITEM = '20000000-0000-4000-8000-000000000072'
const USER = '20000000-0000-4000-8000-000000000073'

let root: Root | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  setPieWorkspaceRoute('chat')
  vi.mocked(apiGet).mockImplementation((path) =>
    Promise.resolve(
      path === '/teams' ? { items: [{ id: TEAM, key: 'CORE', name: 'Core' }] } : { items: [] }
    )
  )
  vi.mocked(apiPostWithIdempotencyKey).mockResolvedValue({
    id: WORK_ITEM,
    identifier: 'CORE-7',
    title: 'Investigate the timeout'
  })
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  document.body.innerHTML = ''
  root = null
  vi.clearAllMocks()
})

describe('MessageWorkItemDialog', () => {
  it('creates one work item with a stable idempotency key and opens it', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const onOpenChange = vi.fn()
    const source = message({ body: 'Investigate the timeout\nDetails follow.' })

    act(() => {
      root?.render(
        <MessageWorkItemDialog
          open
          onOpenChange={onOpenChange}
          channelId={source.channelId}
          assigneeId={USER}
          message={source}
        />
      )
    })
    await flush()

    const title = document.body.querySelector('#message-work-item-title') as HTMLInputElement
    expect(title.value).toBe('Investigate the timeout')
    const create = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Create'
    )
    await act(async () => fireEvent.click(create as Element))
    await flush()

    expect(apiPostWithIdempotencyKey).toHaveBeenCalledWith(
      `/channels/${source.channelId}/messages/${source.id}/work-items`,
      {
        teamId: TEAM,
        title: 'Investigate the timeout',
        priority: 'none',
        assigneeId: USER
      },
      expect.any(String)
    )
    expect(document.body.textContent).toContain('CORE-7')

    const open = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open work item'
    )
    act(() => fireEvent.click(open as Element))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(getPieWorkspaceRoute()).toBe('work-item')
    expect(takePieWorkItemNavigation()).toEqual({ workItemId: WORK_ITEM })
  })

  it('opens an already-linked work item without showing the creation form', async () => {
    vi.mocked(apiGet).mockImplementation((path) => {
      if (path.endsWith('/work-items')) {
        return Promise.resolve({ items: [{ workItemId: WORK_ITEM }] })
      }
      if (path === `/work-items/${WORK_ITEM}`) {
        return Promise.resolve({
          id: WORK_ITEM,
          identifier: 'CORE-7',
          title: 'Investigate the timeout'
        })
      }
      return Promise.resolve({ items: [] })
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const onOpenChange = vi.fn()
    const source = message({ body: 'Investigate the timeout' })

    act(() => {
      root?.render(
        <MessageWorkItemDialog
          open
          onOpenChange={onOpenChange}
          channelId={source.channelId}
          assigneeId={USER}
          message={source}
        />
      )
    })
    await flush()

    expect(document.body.textContent).toContain('Linked work item')
    expect(document.body.querySelector('#message-work-item-title')).toBeNull()
    expect(apiPostWithIdempotencyKey).not.toHaveBeenCalled()
    const open = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open work item'
    )
    act(() => fireEvent.click(open as Element))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(takePieWorkItemNavigation()).toEqual({ workItemId: WORK_ITEM })
  })
})
