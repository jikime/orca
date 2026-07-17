// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

import { DmComposer } from './DmComposer'
import { USER, channel, flush, makeChatApi, member } from './chat-test-fixtures'

const ALICE = '20000000-0000-4000-8000-0000000000a1'

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

function renderComposer(
  api: ReturnType<typeof makeChatApi>,
  onCreated: (ch: ReturnType<typeof channel>) => void
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <DmComposer
        members={[member(ALICE, 'alice')]}
        currentUserId={USER}
        api={api}
        onCreated={onCreated}
      />
    )
  })
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(container?.querySelectorAll('button') ?? []).find(
    (element) => element.textContent === text
  )
}

describe('DmComposer', () => {
  it('creates a channel from the typed name', async () => {
    const created = channel({ name: 'design' })
    const createChannel = vi.fn().mockResolvedValue(created)
    const api = makeChatApi({ createChannel })
    const onCreated = vi.fn()
    renderComposer(api, onCreated)

    const input = container?.querySelector(
      'input[aria-label="New channel name"]'
    ) as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    setValue?.call(input, 'design')
    act(() => input.dispatchEvent(new Event('input', { bubbles: true })))

    act(() => {
      buttonWithText('Create')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(createChannel).toHaveBeenCalledWith('design')
    expect(onCreated).toHaveBeenCalledWith(created)
  })

  it('creates a 1:1 DM with the selected member', async () => {
    const dm = channel({ kind: 'dm' })
    const createDm = vi.fn().mockResolvedValue(dm)
    const api = makeChatApi({ createDm })
    const onCreated = vi.fn()
    renderComposer(api, onCreated)

    act(() => {
      buttonWithText('@alice')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      buttonWithText('Start DM')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(createDm).toHaveBeenCalledWith(ALICE)
    expect(onCreated).toHaveBeenCalledWith(dm)
  })
})
