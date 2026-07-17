// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelComposer } from './ChannelComposer'
import { CHANNEL, member, makeChatApi, flush } from './chat-test-fixtures'

let root: Root | null = null
let container: HTMLDivElement | null = null
let originalCreateObjectURL: typeof URL.createObjectURL | undefined

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL
    })
  }
})

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  originalCreateObjectURL = URL.createObjectURL
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:channel-composer-preview')
  })
})

function renderComposer(
  api: ReturnType<typeof makeChatApi>,
  onSend: (body: string, opts?: unknown) => void | Promise<void> = vi.fn()
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <ChannelComposer
        channelId={CHANNEL}
        members={[member('u-1', 'Ada'), member('u-2', 'Grace')]}
        sending={false}
        api={api}
        onSend={onSend}
      />
    )
  })
}

function attachFile(name: string, type: string): void {
  const input = container?.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['bytes'], name, { type })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('ChannelComposer', () => {
  it('disables Send when the input is empty and there are no attachments', () => {
    renderComposer(makeChatApi())
    const sendButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Send'
    )
    expect(sendButton?.disabled).toBe(true)
  })

  it('enables Send once text is typed', () => {
    renderComposer(makeChatApi())
    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set
    act(() => {
      setValue?.call(textarea, 'hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const sendButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Send'
    )
    expect(sendButton?.disabled).toBe(false)
  })

  it('enables Send once a file is attached, even with empty text', async () => {
    renderComposer(makeChatApi())

    await act(async () => {
      attachFile('note.txt', 'text/plain')
    })
    await flush()

    const sendButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Send'
    )
    expect(sendButton?.disabled).toBe(false)
  })

  it('shows an attachment preview above the textarea without removing the textarea', async () => {
    renderComposer(makeChatApi())
    expect(container?.querySelector('textarea')).not.toBeNull()

    await act(async () => {
      attachFile('diagram.png', 'image/png')
    })
    await flush()

    // Textarea is still present and the preview renders as a thumbnail, not a
    // chip sharing its row — the fix for the old push/displacement bug.
    expect(container?.querySelector('textarea')).not.toBeNull()
    expect(container?.textContent).toContain('diagram.png')
    const img = container?.querySelector('img')
    expect(img?.getAttribute('src')).toBe('blob:channel-composer-preview')
  })

  it('focuses the textarea when the @ mention button is clicked', () => {
    renderComposer(makeChatApi())
    const mentionButton = container?.querySelector(
      'button[aria-label="Mention someone"]'
    ) as HTMLButtonElement
    act(() => {
      mentionButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    expect(document.activeElement).toBe(textarea)
    expect(textarea.value).toBe('@')
  })

  it('sends attachmentIds collected from an upload alongside the message', async () => {
    const onSend = vi.fn()
    renderComposer(makeChatApi(), onSend)

    await act(async () => {
      attachFile('report.pdf', 'application/pdf')
    })
    await flush()

    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set
    act(() => {
      setValue?.call(textarea, 'see attached')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onSend).toHaveBeenCalledWith('see attached', { attachmentIds: ['att-1'] })
  })
})
