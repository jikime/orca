// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentList } from './AttachmentList'
import { CHANNEL, flush, makeChatApi } from './chat-test-fixtures'
import type { PieMessageAttachment } from '../../../../shared/pie-chat-contract'

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

function attachment(overrides: Partial<PieMessageAttachment> = {}): PieMessageAttachment {
  return {
    id: 'att-1',
    filename: 'photo.png',
    contentType: 'image/png',
    byteSize: 2048,
    ...overrides
  }
}

function renderList(api: ReturnType<typeof makeChatApi>, items: PieMessageAttachment[]): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<AttachmentList channelId={CHANNEL} attachments={items} api={api} />)
  })
}

describe('AttachmentList', () => {
  it('renders the filename and a human-readable size', () => {
    renderList(makeChatApi(), [attachment()])
    expect(container?.textContent).toContain('photo.png')
    expect(container?.textContent).toContain('2 KB')
  })

  it('resolves a presigned download url on click', async () => {
    const downloadAttachment = vi.fn().mockResolvedValue({
      url: 'https://dl',
      filename: 'photo.png',
      contentType: 'image/png',
      expiresAt: 'x'
    })
    const api = makeChatApi({ downloadAttachment })
    window.open = vi.fn()
    renderList(api, [attachment()])

    const button = container?.querySelector('button')
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(downloadAttachment).toHaveBeenCalledWith(CHANNEL, 'att-1')
  })
})
