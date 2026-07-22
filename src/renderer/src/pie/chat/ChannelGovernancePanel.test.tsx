// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelGovernancePanel } from './ChannelGovernancePanel'
import { CHANNEL, USER, channel, flush, makeChatApi, member } from './chat-test-fixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('ChannelGovernancePanel', () => {
  it('loads audit activity and saves a bounded retention policy', async () => {
    const listChannelAudit = vi.fn().mockResolvedValue([
      {
        id: '20000000-0000-4000-8000-000000000099',
        actorId: USER,
        action: 'message.deleted',
        targetType: 'message',
        targetId: '20000000-0000-4000-8000-000000000010',
        reason: 'policy violation',
        occurredAt: '2026-07-21T00:00:00.000Z'
      }
    ])
    const updatedChannel = channel({ retentionDays: 30, version: 2 })
    const updateChannel = vi.fn().mockResolvedValue(updatedChannel)
    const onUpdated = vi.fn()
    const api = makeChatApi({ listChannelAudit, updateChannel })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <ChannelGovernancePanel
          channel={channel()}
          currentUserId={USER}
          members={[member(USER, 'Ada')]}
          api={api}
          onUpdated={onUpdated}
        />
      )
    })
    await flush()

    expect(listChannelAudit).toHaveBeenCalledWith(CHANNEL)
    expect(container.textContent).toContain('message.deleted')
    expect(container.textContent).toContain('policy violation')

    act(() =>
      fireEvent.change(container?.querySelector('#channel-retention-days') as Element, {
        target: { value: '30' }
      })
    )
    const save = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save'
    )
    await act(async () => fireEvent.click(save as Element))
    await flush()

    expect(updateChannel).toHaveBeenCalledWith(CHANNEL, { retentionDays: 30 }, 1)
    expect(onUpdated).toHaveBeenCalledWith(updatedChannel)
  })
})
