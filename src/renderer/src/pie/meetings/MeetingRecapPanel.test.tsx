// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../control-plane/pie-api-client', () => ({
  apiGet: control.get,
  PieApiError: class PieApiError extends Error {}
}))

import { MeetingRecapPanel } from './MeetingRecapPanel'

let root: Root | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  document.body.innerHTML = ''
  root = null
  vi.clearAllMocks()
})

describe('MeetingRecapPanel', () => {
  it('collects minutes, decisions, action items, and recording readiness in one view', async () => {
    control.get.mockImplementation((path: string) => {
      if (path.endsWith('/recordings')) {
        return Promise.resolve({
          items: [
            {
              id: 'recording',
              status: 'available',
              durationSeconds: 600,
              createdAt: '2026-07-21T04:00:00.000Z'
            }
          ]
        })
      }
      if (path.endsWith('/minutes')) {
        return Promise.resolve({
          items: [
            {
              id: 'minutes',
              summary: 'Release plan approved.',
              status: 'finalized',
              createdAt: '2026-07-21T04:00:00.000Z'
            }
          ]
        })
      }
      if (path.endsWith('/decisions')) {
        return Promise.resolve({
          items: [{ id: 'decision', statement: 'Ship Friday.', reviewStatus: 'approved' }]
        })
      }
      if (path.endsWith('/action-items')) {
        return Promise.resolve({
          items: [
            {
              id: 'action',
              task: 'Prepare checklist.',
              reviewStatus: 'approved',
              workItemId: 'work'
            }
          ]
        })
      }
      return Promise.resolve({ items: [] })
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<MeetingRecapPanel meetingId="meeting" canManageTranscript={false} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Release plan approved.')
    expect(container.textContent).toContain('Ship Friday.')
    expect(container.textContent).toContain('Prepare checklist.')
    expect(container.textContent).toContain('10 min')
  })
})
