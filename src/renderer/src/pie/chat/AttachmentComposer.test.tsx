// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentComposer, type PendingAttachment } from './AttachmentComposer'
import { CHANNEL, flush, makeChatApi } from './chat-test-fixtures'

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
    value: vi.fn(() => 'blob:attachment-preview')
  })
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
    // Non-image uploads carry a contentType but no local preview URL.
    expect(onChange).toHaveBeenCalledWith([
      { id: 'att-42', filename: 'note.txt', contentType: 'text/plain', previewUrl: undefined }
    ])
  })

  it('captures an object-URL preview for an image upload', async () => {
    const uploadAttachment = vi
      .fn()
      .mockResolvedValue({ id: 'att-7', objectId: 'obj', uploadUrl: 'https://up', expiresAt: 'x' })
    const api = makeChatApi({ uploadAttachment })
    const onChange = vi.fn()
    renderComposer(api, [], onChange)

    const input = container?.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['fake-bytes'], 'diagram.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    expect(onChange).toHaveBeenCalledWith([
      {
        id: 'att-7',
        filename: 'diagram.png',
        contentType: 'image/png',
        previewUrl: 'blob:attachment-preview'
      }
    ])
  })

  it('does not render attachment chips itself — that is ComposerAttachmentPreview', () => {
    renderComposer(makeChatApi(), [{ id: 'att-1', filename: 'diagram.png' }], vi.fn())
    expect(container?.textContent).not.toContain('diagram.png')
  })
})
