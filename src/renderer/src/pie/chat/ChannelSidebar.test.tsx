// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelSidebar } from './ChannelSidebar'
import { channel, member, makeChatApi, USER, OTHER } from './chat-test-fixtures'
import type { PieChannel } from '../../../../shared/pie-chat-contract'

const CH = '20000000-0000-4000-8000-0000000000e1'
const DM = '20000000-0000-4000-8000-0000000000e2'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(node: React.JSX.Element): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('ChannelSidebar', () => {
  it('renders channels and DMs together, selecting a DM row by id', () => {
    const onSelect = vi.fn()
    render(
      <ChannelSidebar
        channels={[
          channel({ id: CH, name: 'general' }),
          channel({
            id: DM,
            kind: 'dm',
            name: '',
            participantUserIds: [USER, OTHER]
          } as Partial<PieChannel> as PieChannel)
        ]}
        members={[member(OTHER, 'Bianca')]}
        selectedChannelId={CH}
        loading={false}
        currentUserId={USER}
        api={makeChatApi()}
        onSelect={onSelect}
        onChannelCreated={vi.fn()}
      />
    )

    expect(container?.textContent).toContain('general')
    expect(container?.textContent).toContain('Direct messages')
    expect(container?.textContent).toContain('Bianca')

    const dmRow = [...(container?.querySelectorAll('button') ?? [])].find((el) =>
      el.textContent?.includes('Bianca')
    ) as HTMLButtonElement
    act(() => dmRow.click())
    expect(onSelect).toHaveBeenCalledWith(DM)
  })

  it('shows the DM empty state while the channels list still renders', () => {
    render(
      <ChannelSidebar
        channels={[channel({ id: CH, name: 'general' })]}
        members={[]}
        selectedChannelId={null}
        loading={false}
        currentUserId={USER}
        api={makeChatApi()}
        onSelect={vi.fn()}
        onChannelCreated={vi.fn()}
      />
    )

    expect(container?.textContent).toContain('general')
    expect(container?.textContent).toContain('No direct messages yet')
  })
})
