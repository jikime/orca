// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkItem } from './use-work-item-board'

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  refetchItems: vi.fn()
}))

const item: WorkItem = {
  id: '20000000-0000-4000-8000-000000000001',
  identifier: 'CORE-7',
  title: 'Prepare release',
  stateId: '20000000-0000-4000-8000-000000000002',
  priority: 'high',
  assigneeId: null,
  projectId: null,
  version: 1,
  workflowVersion: 3
}

const resourceData = {
  teams: { items: [{ id: 'team-1', name: 'Core' }] },
  states: {
    items: [
      { id: item.stateId, name: 'Todo', category: 'unstarted', sortKey: 0 },
      { id: 'state-done', name: 'Done', category: 'completed', sortKey: 1 }
    ]
  },
  items: { items: [item] }
}

vi.mock('../control-plane/pie-api-client', () => ({
  apiPatch: vi.fn(),
  apiPost: mocks.apiPost,
  PieApiError: class PieApiError extends Error {},
  resourceEtag: vi.fn()
}))

vi.mock('../control-plane/use-pie-resource', () => ({
  usePieResource: (path: string | null) => {
    if (path === '/teams') {
      return resource(resourceData.teams)
    }
    if (path === '/teams/team-1/workflow-states') {
      return resource(resourceData.states)
    }
    return resource(resourceData.items, mocks.refetchItems)
  }
}))

function resource(data: unknown, refetch = vi.fn()) {
  return { data, loading: false, error: null, refetch }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

import { useWorkItemBoard } from './use-work-item-board'

describe('useWorkItemBoard optimistic movement', () => {
  beforeEach(() => {
    mocks.apiPost.mockReset()
    mocks.refetchItems.mockReset()
  })

  it('moves immediately and replaces the card with the server version', async () => {
    const request = deferred<WorkItem>()
    const updated = { ...item, stateId: 'state-done', version: 2 }
    mocks.apiPost.mockReturnValue(request.promise)
    const { result } = renderHook(() => useWorkItemBoard())
    await waitFor(() => expect(result.current.items).toEqual([item]))

    let movePromise!: Promise<void>
    act(() => {
      movePromise = result.current.move(item, 'state-done')
    })

    expect(result.current.items[0]?.stateId).toBe('state-done')
    expect(result.current.movingItemIds.has(item.id)).toBe(true)
    expect(mocks.apiPost).toHaveBeenCalledWith(`/work-items/${item.id}:move-state`, {
      fromStateId: item.stateId,
      toStateId: 'state-done',
      workflowVersion: item.workflowVersion,
      expectedVersion: item.version
    })

    await act(async () => {
      request.resolve(updated)
      await movePromise
    })

    expect(result.current.items).toEqual([updated])
    expect(result.current.movingItemIds.has(item.id)).toBe(false)
    expect(mocks.refetchItems).toHaveBeenCalledOnce()
  })

  it('rolls the card back when the OCC-guarded move fails', async () => {
    const request = deferred<WorkItem>()
    mocks.apiPost.mockReturnValue(request.promise)
    const { result } = renderHook(() => useWorkItemBoard())
    await waitFor(() => expect(result.current.items).toEqual([item]))

    let movePromise!: Promise<void>
    act(() => {
      movePromise = result.current.move(item, 'state-done')
    })
    expect(result.current.items[0]?.stateId).toBe('state-done')

    await act(async () => {
      request.reject(new Error('work item move precondition failed'))
      await movePromise
    })

    expect(result.current.items).toEqual([item])
    expect(result.current.error).toContain('work item move precondition failed')
    expect(result.current.movingItemIds.has(item.id)).toBe(false)
    expect(mocks.refetchItems).toHaveBeenCalledOnce()
  })
})
