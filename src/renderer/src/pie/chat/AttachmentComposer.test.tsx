// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentComposer, type PendingAttachment } from './AttachmentComposer'
import { CHANNEL, flush, makeChatApi } from './chat-test-fixtures'

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
  attachments: PendingAttachment[],
  onChange: (next: PendingAttachment[]) => void
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <AttachmentComposer
        channelId={CHANNEL}
        api={api}
        attachments={attachments}
        onChange={onChange}
      />
    )
  })
}

describe('AttachmentComposer', () => {
  it('uploads a picked file and records the returned attachment id', async () => {
    const uploadAttachment = vi
      .fn()
      .mockResolvedValue({ id: 'att-42', objectId: 'obj', uploadUrl: 'https://up', expiresAt: 'x' })
    const api = makeChatApi({ uploadAttachment })
    const onChange = vi.fn()
    renderComposer(api, [], onChange)

    const input = container?.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    expect(uploadAttachment).toHaveBeenCalledWith(
      CHANNEL,
      { filename: 'note.txt', contentType: 'text/plain', byteSize: file.size },
      expect.any(ArrayBuffer)
    )
    expect(onChange).toHaveBeenCalledWith([{ id: 'att-42', filename: 'note.txt' }])
  })

  it('renders a chip for each pending attachment', () => {
    renderComposer(makeChatApi(), [{ id: 'att-1', filename: 'diagram.png' }], vi.fn())
    expect(container?.textContent).toContain('diagram.png')
  })
})
