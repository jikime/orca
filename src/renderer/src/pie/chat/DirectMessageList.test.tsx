// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectMessageList } from './DirectMessageList'
import { channel, member, USER, OTHER } from './chat-test-fixtures'
import type { PieChannel } from '../../../../shared/pie-chat-contract'

const DM_A = '20000000-0000-4000-8000-0000000000d1'
const DM_B = '20000000-0000-4000-8000-0000000000d2'

// The control-plane rides participant ids on a passthrough field; model that here.
function dm(id: string, overrides: Partial<PieChannel> = {}): PieChannel {
  return channel({ id, kind: 'dm', name: '', ...overrides })
}

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

describe('DirectMessageList', () => {
  it('renders one row per DM labelled by the resolved other participant, with an avatar', () => {
    render(
      <DirectMessageList
        dms={[
          dm(DM_A, { participantUserIds: [USER, OTHER] } as Partial<PieChannel>),
          dm(DM_B, { name: 'design-team' })
        ]}
        members={[member(OTHER, 'Bianca')]}
        currentUserId={USER}
        selectedChannelId={null}
        onSelect={vi.fn()}
      />
    )

    const rows = container?.querySelectorAll('button') ?? []
    expect(rows.length).toBe(2)
    // Resolved via members, not the (empty) channel name.
    expect(container?.textContent).toContain('Bianca')
    // Unresolved participants fall back to the backend-provided channel name.
    expect(container?.textContent).toContain('design-team')
    // MessageAvatar renders initials of the resolved label.
    expect(container?.textContent).toContain('BI')
  })

  it('labels by memberUserIds — the field the control-plane channel resource now carries', () => {
    // The backend attaches the DM roster as memberUserIds (channel-store); a DM whose
    // stored name is the generic 'Direct Message' must still resolve to the other member.
    render(
      <DirectMessageList
        dms={[
          dm(DM_A, { name: 'Direct Message', memberUserIds: [USER, OTHER] } as Partial<PieChannel>)
        ]}
        members={[member(OTHER, 'Bianca')]}
        currentUserId={USER}
        selectedChannelId={null}
        onSelect={vi.fn()}
      />
    )

    expect(container?.textContent).toContain('Bianca')
    // The generic stored name must NOT leak through once the roster resolves.
    expect(container?.textContent).not.toContain('Direct Message')
  })

  it('selects the DM channel when its row is clicked', () => {
    const onSelect = vi.fn()
    render(
      <DirectMessageList
        dms={[dm(DM_A, { participantUserIds: [USER, OTHER] } as Partial<PieChannel>)]}
        members={[member(OTHER, 'Bianca')]}
        currentUserId={USER}
        selectedChannelId={null}
        onSelect={onSelect}
      />
    )

    const row = container?.querySelector('button') as HTMLButtonElement
    act(() => row.click())
    expect(onSelect).toHaveBeenCalledWith(DM_A)
  })

  it('marks the active DM row with aria-current and data-current', () => {
    render(
      <DirectMessageList
        dms={[dm(DM_A, { name: 'ada' }), dm(DM_B, { name: 'grace' })]}
        members={[]}
        currentUserId={USER}
        selectedChannelId={DM_A}
        onSelect={vi.fn()}
      />
    )

    const active = container?.querySelector('[aria-current="true"]') as HTMLButtonElement
    expect(active?.textContent).toContain('ada')
    expect(active?.getAttribute('data-current')).toBe('true')
  })

  it('shows a quiet empty state when there are no DMs', () => {
    render(
      <DirectMessageList
        dms={[]}
        members={[]}
        currentUserId={USER}
        selectedChannelId={null}
        onSelect={vi.fn()}
      />
    )

    expect(container?.textContent).toContain('No direct messages yet')
    expect(container?.querySelectorAll('button').length).toBe(0)
  })

  it('falls back to an id slice when neither participants nor a name resolve', () => {
    render(
      <DirectMessageList
        dms={[dm(DM_A)]}
        members={[]}
        currentUserId={USER}
        selectedChannelId={null}
        onSelect={vi.fn()}
      />
    )

    expect(container?.textContent).toContain(DM_A.slice(0, 8))
  })
})
