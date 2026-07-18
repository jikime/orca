// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { ComposerFormattingToolbar } from './ComposerFormattingToolbar'
import { ComposerToolbar } from './ComposerToolbar'
import { createChatComposerExtensions } from './chat-composer-editor-extensions'

let root: Root | null = null
let container: HTMLDivElement | null = null
let editor: Editor | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  editor?.destroy()
  root = null
  container = null
  editor = null
})

function renderToolbar(html: string): Editor {
  container = document.createElement('div')
  document.body.appendChild(container)
  const host = document.createElement('div')
  container.appendChild(host)
  editor = new Editor({
    element: host,
    extensions: createChatComposerExtensions('placeholder'),
    content: html,
    contentType: 'html'
  })
  const toolbarRoot = document.createElement('div')
  container.appendChild(toolbarRoot)
  root = createRoot(toolbarRoot)
  act(() => root?.render(<ComposerFormattingToolbar editor={editor} />))
  return editor
}

function click(selector: string): void {
  const button = container?.querySelector(selector) as HTMLElement
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('ComposerFormattingToolbar', () => {
  it('toggles bold on the selection so it serializes to **…**', () => {
    const active = renderToolbar('<p>hello world</p>')
    // Select "world" (doc positions: 1 = start of paragraph text).
    act(() => active.commands.setTextSelection({ from: 7, to: 12 }))
    click('[aria-label="Bold"]')
    expect(active.getMarkdown().trimEnd()).toBe('hello **world**')
  })

  it('turns the current block into an ordered list', () => {
    const active = renderToolbar('<p>one</p>')
    act(() => active.commands.setTextSelection(2))
    click('[aria-label="Ordered list"]')
    expect(active.getMarkdown().trimEnd()).toBe('1. one')
  })

  it('toggles underline to a <u> tag rather than markdown ++', () => {
    const active = renderToolbar('<p>note</p>')
    act(() => active.commands.setTextSelection({ from: 1, to: 5 }))
    click('[aria-label="Underline"]')
    expect(active.getMarkdown().trimEnd()).toBe('<u>note</u>')
  })

  it('reflects the active mark as a pressed toggle', () => {
    const active = renderToolbar('<p><strong>bold</strong></p>')
    act(() => active.commands.setTextSelection({ from: 1, to: 5 }))
    // Re-render the toolbar against the current selection state.
    act(() => root?.render(<ComposerFormattingToolbar editor={active} />))
    const boldButton = container?.querySelector('[aria-label="Bold"]') as HTMLElement
    expect(boldButton.getAttribute('data-state')).toBe('on')
  })
})

// The Aa visibility toggle lives on ComposerToolbar; a composer hides the whole
// formatting row with it, so it is verified alongside the formatting buttons.
function VisibilityHarness(): React.JSX.Element {
  const [visible, setVisible] = useState(true)
  return (
    <div>
      {visible && <ComposerFormattingToolbar editor={null} />}
      <ComposerToolbar
        canSend={false}
        sending={false}
        onSend={() => {}}
        formattingVisible={visible}
        onToggleFormatting={() => setVisible((current) => !current)}
      />
    </div>
  )
}

describe('formatting row visibility', () => {
  it('hides the formatting row when the Aa toggle is pressed', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<VisibilityHarness />))
    expect(container?.querySelector('[aria-label="Bold"]')).not.toBeNull()
    const toggle = container?.querySelector('[aria-label="Toggle formatting"]') as HTMLElement
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container?.querySelector('[aria-label="Bold"]')).toBeNull()
  })
})
