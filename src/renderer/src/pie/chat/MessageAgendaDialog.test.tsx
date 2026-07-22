// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiPostWithIdempotencyKey } from '../control-plane/pie-api-client'
import { takePieMeetingNavigation } from '../meetings/pie-meeting-navigation'
import { getPieWorkspaceRoute, setPieWorkspaceRoute } from '../workspace/pie-workspace-route'
import { CHANNEL, message } from './chat-test-fixtures'
import { MessageAgendaDialog } from './MessageAgendaDialog'

vi.mock('../control-plane/pie-api-client', () => ({
  apiPostWithIdempotencyKey: vi.fn(),
  PieApiError: class PieApiError extends Error {}
}))

const MEETING = '20000000-0000-4000-8000-000000000073'
let root: Root | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  setPieWorkspaceRoute('chat')
  vi.mocked(apiPostWithIdempotencyKey).mockResolvedValue({
    id: '20000000-0000-4000-8000-000000000074',
    body: 'Review launch risks.'
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

describe('MessageAgendaDialog', () => {
  it('promotes the source message and opens the owning meeting', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const onOpenChange = vi.fn()
    const source = message({ body: 'Review launch risks.' })

    act(() => {
      root?.render(
        <MessageAgendaDialog
          open
          onOpenChange={onOpenChange}
          meetingId={MEETING}
          channelId={CHANNEL}
          message={source}
        />
      )
    })
    await flush()

    const add = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add to agenda'
    )
    await act(async () => fireEvent.click(add as Element))
    await flush()

    expect(apiPostWithIdempotencyKey).toHaveBeenCalledWith(
      `/meetings/${MEETING}/agenda-items`,
      { sourceChannelId: CHANNEL, sourceMessageId: source.id },
      expect.any(String)
    )
    const openMeeting = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open meeting'
    )
    act(() => fireEvent.click(openMeeting as Element))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(getPieWorkspaceRoute()).toBe('meetings')
    expect(takePieMeetingNavigation()).toEqual({ meetingId: MEETING })
  })
})
