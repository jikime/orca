// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionAutocomplete, filterMembers } from './MentionAutocomplete'
import { ChannelComposer } from './ChannelComposer'
import { CHANNEL, makeChatApi, member, typeInto } from './chat-test-fixtures'
import type { PieChatMember } from '../../../../shared/pie-chat-contract'

const ALICE = '20000000-0000-4000-8000-0000000000a1'
const BOB = '20000000-0000-4000-8000-0000000000b2'

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

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

function mount(node: React.JSX.Element): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(node)
  })
}

describe('MentionAutocomplete', () => {
  const members: PieChatMember[] = [member(ALICE, 'alice'), member(BOB, 'bob')]

  it('filters members by the text after @', () => {
    expect(filterMembers(members, 'ali').map((m) => m.displayName)).toEqual(['alice'])
    expect(filterMembers(members, '')).toHaveLength(2)
  })

  it('renders matches and selects one on mouse down', () => {
    const onSelect = vi.fn()
    mount(<MentionAutocomplete members={members} query="ali" activeIndex={0} onSelect={onSelect} />)
    const option = container?.querySelector('[role="option"]')
    expect(option?.textContent).toContain('alice')
    act(() => {
      option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith(members[0])
  })

  it('renders nothing when no member matches', () => {
    mount(<MentionAutocomplete members={members} query="zzz" activeIndex={0} onSelect={vi.fn()} />)
    expect(container?.querySelector('[role="listbox"]')).toBeNull()
  })

  it('inserts a mention in the composer and sends it as a mention id', async () => {
    const onSend = vi.fn()
    mount(
      <ChannelComposer
        channelId={CHANNEL}
        members={members}
        sending={false}
        api={makeChatApi()}
        onSend={onSend}
      />
    )
    // Typing '@ali' surfaces the autocomplete; a mousedown on the match inserts it.
    act(() => {
      typeInto(container as HTMLElement, 'hey @ali')
    })
    const option = container?.querySelector('[role="option"]')
    expect(option?.textContent).toContain('alice')
    act(() => {
      option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toContain('@alice')

    const sendButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (element) => element.textContent === 'Send'
    )
    act(() => {
      sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSend).toHaveBeenCalledWith('hey @alice ', { mentions: [ALICE] })
  })
})
