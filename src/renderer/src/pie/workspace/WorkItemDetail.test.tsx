// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ setActiveView: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setActiveView: control.setActiveView }) }
}))

vi.mock('../control-plane/use-pie-resource', () => ({
  usePieResource: () => ({
    data: {
      items: [
        {
          kind: 'chat_message',
          sourceId: '30000000-0000-4000-8000-000000000001',
          containerId: '30000000-0000-4000-8000-000000000002',
          containerLabel: 'general',
          createdAt: '2026-07-21T00:00:00.000Z'
        },
        {
          kind: 'meeting_action_item',
          sourceId: '40000000-0000-4000-8000-000000000001',
          containerId: '40000000-0000-4000-8000-000000000002',
          containerLabel: 'Weekly planning',
          createdAt: '2026-07-21T00:00:00.000Z'
        }
      ]
    },
    loading: false,
    error: null,
    refetch: vi.fn()
  })
}))

import { WorkItemDetail } from './WorkItemDetail'
import { takePieChatNavigation } from '../chat/pie-chat-navigation'
import { takePieMeetingNavigation } from '../meetings/pie-meeting-navigation'
import type { WorkItem } from './use-work-item-board'

const item: WorkItem = {
  id: '20000000-0000-4000-8000-000000000001',
  identifier: 'CORE-7',
  title: 'Prepare release',
  description: 'Tracked work',
  stateId: '20000000-0000-4000-8000-000000000002',
  priority: 'high',
  assigneeId: null,
  projectId: null,
  version: 1,
  workflowVersion: 1
}

let root: Root | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  document.body.innerHTML = ''
  root = null
  vi.clearAllMocks()
  takePieChatNavigation()
  takePieMeetingNavigation()
})

describe('WorkItemDetail source navigation', () => {
  it('opens structured chat and meeting sources in the Pie workspace', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <WorkItemDetail
          item={item}
          columns={[{ id: item.stateId, name: 'Todo', category: 'unstarted', sortKey: 0 }]}
          members={[]}
          onMove={vi.fn()}
          onAssign={vi.fn()}
          onSetPriority={vi.fn()}
          onClose={vi.fn()}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    const chat = buttons.find((button) => button.textContent?.includes('Open source message'))
    const meeting = buttons.find((button) => button.textContent?.includes('Open source meeting'))
    act(() => fireEvent.click(chat as Element))
    expect(takePieChatNavigation()).toEqual({
      channelId: '30000000-0000-4000-8000-000000000002',
      messageId: '30000000-0000-4000-8000-000000000001'
    })
    act(() => fireEvent.click(meeting as Element))
    expect(takePieMeetingNavigation()).toEqual({
      meetingId: '40000000-0000-4000-8000-000000000002',
      actionItemId: '40000000-0000-4000-8000-000000000001'
    })
    expect(control.setActiveView).toHaveBeenCalledTimes(2)
    expect(control.setActiveView).toHaveBeenCalledWith('pie')
  })
})
