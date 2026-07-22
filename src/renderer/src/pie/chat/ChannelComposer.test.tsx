// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelComposer } from './ChannelComposer'
import { CHANNEL, member, makeChatApi, flush, typeInto } from './chat-test-fixtures'
import { chatComposerDraftKey, readChatComposerDraft } from './chat-composer-draft-store'

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
  window.localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  originalCreateObjectURL = URL.createObjectURL
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:channel-composer-preview')
  })
})

async function renderComposer(
  api: ReturnType<typeof makeChatApi>,
  onSend: (body: string, opts?: unknown) => void | Promise<void> = vi.fn()
): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <ChannelComposer
        channelId={CHANNEL}
        draftOwnerId="u-1"
        members={[member('u-1', 'Ada'), member('u-2', 'Grace')]}
        sending={false}
        api={api}
        onSend={onSend}
      />
    )
  })
  // The rich editor is created in an effect; flush before assertions.
  await act(async () => {
    await Promise.resolve()
  })
}

function sendButton(): HTMLButtonElement | undefined {
  return Array.from(container?.querySelectorAll('button') ?? []).find(
    (button) => button.textContent === 'Send'
  )
}

function attachFile(name: string, type: string): void {
  const input = container?.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['bytes'], name, { type })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('ChannelComposer', () => {
  it('disables Send when the editor is empty and there are no attachments', async () => {
    await renderComposer(makeChatApi())
    expect(sendButton()?.disabled).toBe(true)
  })

  it('renders the WYSIWYG editor with a formatting toolbar instead of a textarea', async () => {
    await renderComposer(makeChatApi())
    expect(container?.querySelector('textarea')).toBeNull()
    expect(container?.querySelector('[contenteditable="true"]')).not.toBeNull()
    expect(container?.querySelector('button[aria-label="Bold"]')).not.toBeNull()
  })

  it('enables Send once a file is attached, even with empty text', async () => {
    await renderComposer(makeChatApi())
    await act(async () => {
      attachFile('note.txt', 'text/plain')
    })
    await flush()
    expect(sendButton()?.disabled).toBe(false)
  })

  it('shows an attachment preview above the editor without removing the editor', async () => {
    await renderComposer(makeChatApi())
    expect(container?.querySelector('[contenteditable="true"]')).not.toBeNull()

    await act(async () => {
      attachFile('diagram.png', 'image/png')
    })
    await flush()

    expect(container?.querySelector('[contenteditable="true"]')).not.toBeNull()
    expect(container?.textContent).toContain('diagram.png')
    const img = container?.querySelector('img')
    expect(img?.getAttribute('src')).toBe('blob:channel-composer-preview')
  })

  it('opens the mention autocomplete and inserts a member when the @ button is used', async () => {
    const onSend = vi.fn()
    await renderComposer(makeChatApi(), onSend)

    const mentionButton = container?.querySelector(
      'button[aria-label="Mention someone"]'
    ) as HTMLButtonElement
    act(() => {
      mentionButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const option = container?.querySelector('[role="option"]') as HTMLElement
    expect(option).not.toBeNull()
    act(() => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })

    // Selecting a member makes the message sendable and carries the user id.
    expect(sendButton()?.disabled).toBe(false)
    act(() => {
      sendButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSend).toHaveBeenCalledWith('@Ada', { mentions: ['u-1'] }, expect.any(String))
  })

  it('sends attachmentIds collected from an upload alongside the message', async () => {
    const onSend = vi.fn()
    await renderComposer(makeChatApi(), onSend)

    await act(async () => {
      attachFile('report.pdf', 'application/pdf')
    })
    await flush()

    act(() => {
      sendButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSend).toHaveBeenCalledWith('', { attachmentIds: ['att-1'] }, expect.any(String))
  })

  it('sends group mentions as structured notification options', async () => {
    const onSend = vi.fn()
    await renderComposer(makeChatApi(), onSend)

    await act(async () => typeInto(container as HTMLElement, 'Heads up @channel and @here'))
    act(() => sendButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(onSend).toHaveBeenCalledWith(
      'Heads up @channel and @here',
      {
        mentionChannel: true,
        mentionHere: true
      },
      expect.any(String)
    )
  })

  it('restores a channel draft after the composer remounts', async () => {
    const api = makeChatApi()
    await renderComposer(api)
    await act(async () => typeInto(container as HTMLElement, '**keep me**'))
    expect(readChatComposerDraft(chatComposerDraftKey('u-1', CHANNEL))?.body).toBe('**keep me**')

    act(() => root?.unmount())
    root = null
    expect(readChatComposerDraft(chatComposerDraftKey('u-1', CHANNEL))?.body).toBe('**keep me**')
    container?.remove()
    container = null
    await renderComposer(api)

    expect(readChatComposerDraft(chatComposerDraftKey('u-1', CHANNEL))?.body).toBe('**keep me**')
    expect(document.querySelector('[contenteditable="true"]')?.textContent).toBe('keep me')
  })

  it('keeps the draft when sending fails and clears it after a successful retry', async () => {
    const onSend = vi
      .fn<(body: string, opts?: unknown, clientRequestId?: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)
    await renderComposer(makeChatApi(), onSend)
    await act(async () => typeInto(container as HTMLElement, 'retry me'))

    act(() => sendButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(container?.querySelector('[contenteditable="true"]')?.textContent).toContain('retry me')

    act(() => sendButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(container?.querySelector('[contenteditable="true"]')?.textContent).toBe('')
    expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2])
  })

  it('retries the same file after an attachment upload failure', async () => {
    const uploadAttachment = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ id: 'att-1' })
    await renderComposer(makeChatApi({ uploadAttachment }))
    await act(async () => attachFile('report.pdf', 'application/pdf'))
    await flush()

    const retry = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Retry'
    )
    act(() => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(uploadAttachment).toHaveBeenCalledTimes(2)
    expect(container?.textContent).toContain('report.pdf')
  })
})
