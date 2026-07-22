// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Render the dialog content inline so the search input is reachable without
// driving Radix's portal/open lifecycle.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

import { MessageSearch } from './MessageSearch'
import { flush, makeChatApi, message } from './chat-test-fixtures'

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

function renderSearch(
  api: ReturnType<typeof makeChatApi>,
  onSelect: (msg: ReturnType<typeof message>) => void
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<MessageSearch api={api} members={[]} onSelect={onSelect} />)
  })
}

function typeQuery(text: string): void {
  const input = container?.querySelector('input[aria-label="Search query"]') as HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressEnter(): void {
  const input = container?.querySelector('input[aria-label="Search query"]') as HTMLInputElement
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

describe('MessageSearch', () => {
  it('searches on Enter and renders the results', async () => {
    const searchMessages = vi
      .fn()
      .mockResolvedValue({ items: [message({ body: 'matched line' })], nextCursor: null })
    const api = makeChatApi({ searchMessages })
    renderSearch(api, vi.fn())

    act(() => typeQuery('matched'))
    act(() => pressEnter())
    await flush()

    expect(searchMessages).toHaveBeenCalledWith('matched')
    expect(container?.textContent).toContain('matched line')
  })

  it('invokes onSelect with the chosen result', async () => {
    const hit = message({ body: 'matched line' })
    const api = makeChatApi({
      searchMessages: vi.fn().mockResolvedValue({ items: [hit], nextCursor: null })
    })
    const onSelect = vi.fn()
    renderSearch(api, onSelect)

    act(() => typeQuery('matched'))
    act(() => pressEnter())
    await flush()

    const resultButton = Array.from(container?.querySelectorAll('button') ?? []).find((element) =>
      element.textContent?.includes('matched line')
    )
    act(() => {
      resultButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith(hit)
  })
})
