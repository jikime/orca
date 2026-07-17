// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerAttachmentPreview } from './ComposerAttachmentPreview'
import type { PendingAttachment } from './AttachmentComposer'

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

function render(attachments: PendingAttachment[], onRemove: (id: string) => void): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<ComposerAttachmentPreview attachments={attachments} onRemove={onRemove} />)
  })
}

describe('ComposerAttachmentPreview', () => {
  it('renders nothing when there are no pending attachments', () => {
    render([], vi.fn())
    expect(container?.textContent).toBe('')
  })

  it('renders a file chip with a 📎 icon when no local preview URL is available', () => {
    render([{ id: 'att-1', filename: 'notes.txt' }], vi.fn())
    expect(container?.textContent).toContain('notes.txt')
    expect(container?.querySelector('img')).toBeNull()
  })

  it('renders an image thumbnail instead of a chip icon when a preview URL is set', () => {
    render(
      [{ id: 'att-2', filename: 'diagram.png', contentType: 'image/png', previewUrl: 'blob:x' }],
      vi.fn()
    )
    const img = container?.querySelector('img')
    expect(img?.getAttribute('src')).toBe('blob:x')
  })

  it('calls onRemove with the attachment id when the ✕ button is clicked', () => {
    const onRemove = vi.fn()
    render([{ id: 'att-3', filename: 'file.txt' }], onRemove)

    const removeButton = container?.querySelector('button[aria-label="Remove file.txt"]')
    act(() => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onRemove).toHaveBeenCalledWith('att-3')
  })
})
