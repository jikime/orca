// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }))

vi.mock('../control-plane/pie-api-client', () => ({
  apiGet: control.get,
  apiPatch: control.patch,
  apiPost: control.post,
  resourceEtag: (prefix: string, version: number) => `"${prefix}-${version}"`,
  PieApiError: class PieApiError extends Error {}
}))

import { MeetingOutcomesPanel } from './MeetingOutcomesPanel'
import { subscribeMeetingRecordingSeek } from './meeting-recording-navigation'
import type { MeetingActionItem, MeetingDecision, MeetingTranscriptSegment } from './meeting-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const meetingId = '20000000-0000-4000-8000-000000000001'
const decision: MeetingDecision = {
  id: '30000000-0000-4000-8000-000000000001',
  organizationId: '10000000-0000-4000-8000-000000000001',
  meetingId,
  minutesId: null,
  statement: 'Ship on Friday.',
  status: 'proposed',
  ownerUserId: null,
  projectId: null,
  ticketId: null,
  evidenceSegmentId: '50000000-0000-4000-8000-000000000001',
  createdBy: 'ai',
  reviewStatus: 'unreviewed',
  reviewedBy: null,
  reviewedAt: null,
  version: 1,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z'
}
const actionItem: MeetingActionItem = {
  id: '40000000-0000-4000-8000-000000000001',
  organizationId: decision.organizationId,
  meetingId,
  minutesId: null,
  task: 'Prepare checklist.',
  assigneeUserId: null,
  assigneeLabel: 'Mina',
  dueAt: null,
  dueText: 'Friday',
  priority: 'high',
  status: 'proposed',
  projectId: null,
  ticketId: null,
  workItemId: null,
  evidenceSegmentId: null,
  createdBy: 'ai',
  reviewStatus: 'unreviewed',
  reviewedBy: null,
  reviewedAt: null,
  version: 1,
  createdAt: decision.createdAt,
  updatedAt: decision.updatedAt
}
const segment = { id: decision.evidenceSegmentId, startMs: 12_500 } as MeetingTranscriptSegment

let root: Root | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  control.get.mockImplementation((path: string) => {
    if (path === `/meetings/${meetingId}/decisions`) {
      return Promise.resolve({ items: [decision] })
    }
    if (path === `/meetings/${meetingId}/action-items`) {
      return Promise.resolve({ items: [actionItem] })
    }
    if (path === `/meeting-transcript-segments/${decision.evidenceSegmentId}`) {
      return Promise.resolve(segment)
    }
    return Promise.resolve({ items: [] })
  })
  control.post.mockResolvedValue({ ...decision, reviewStatus: 'approved', version: 2 })
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  document.body.innerHTML = ''
  root = null
  vi.clearAllMocks()
})

describe('MeetingOutcomesPanel', () => {
  it('reviews AI decisions and opens their transcript evidence at the recording position', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const seek = vi.fn()
    const unsubscribe = subscribeMeetingRecordingSeek(seek)

    act(() => {
      root?.render(
        <MeetingOutcomesPanel
          meetingId={meetingId}
          permissions={['meeting.manage', 'meeting.minutes.review', 'work_item.create']}
        />
      )
    })
    await flush()

    expect(container.textContent).toContain('Ship on Friday.')
    const evidence = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Evidence')
    )
    await act(async () => fireEvent.click(evidence as Element))
    await flush()
    expect(seek).toHaveBeenCalledWith(12_500)

    const approve = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Approve')
    )
    await act(async () => fireEvent.click(approve as Element))
    expect(control.post).toHaveBeenCalledWith(
      `/meeting-decisions/${decision.id}:review`,
      { decision: 'approve' },
      '"meeting-decision-1"'
    )
    unsubscribe()
  })

  it('opens the actions tab and focuses a linked action item', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <MeetingOutcomesPanel
          meetingId={meetingId}
          permissions={[]}
          focusedActionItemId={actionItem.id}
        />
      )
    })
    await flush()

    expect(container.textContent).toContain('Prepare checklist.')
    expect(container.querySelector('[data-focused="true"]')).not.toBeNull()
  })
})
