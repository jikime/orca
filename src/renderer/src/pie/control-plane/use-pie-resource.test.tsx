// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePieResource } from './use-pie-resource'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn()
}))

vi.mock('./pie-api-client', () => ({
  apiGet: mocks.apiGet
}))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('usePieResource', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset()
  })

  it('keeps existing data visible during a background refetch', async () => {
    const initial = deferred<{ value: string }>()
    const refresh = deferred<{ value: string }>()
    mocks.apiGet.mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise)

    const { result } = renderHook(() => usePieResource<{ value: string }>('/meeting'))
    expect(result.current.loading).toBe(true)

    await act(async () => initial.resolve({ value: 'first' }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual({ value: 'first' })

    act(() => result.current.refetch())
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(2))
    expect(result.current.loading).toBe(false)
    expect(result.current.data).toEqual({ value: 'first' })

    await act(async () => refresh.resolve({ value: 'second' }))
    await waitFor(() => expect(result.current.data).toEqual({ value: 'second' }))
  })

  it('returns to initial loading when the resource path changes', async () => {
    mocks.apiGet.mockResolvedValueOnce({ value: 'first' })
    const next = deferred<{ value: string }>()
    mocks.apiGet.mockReturnValueOnce(next.promise)

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => usePieResource<{ value: string }>(path),
      { initialProps: { path: '/first' } }
    )
    await waitFor(() => expect(result.current.data).toEqual({ value: 'first' }))

    rerender({ path: '/second' })
    await waitFor(() => expect(result.current.loading).toBe(true))
    expect(result.current.data).toBeNull()

    await act(async () => next.resolve({ value: 'second' }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual({ value: 'second' })
  })
})
