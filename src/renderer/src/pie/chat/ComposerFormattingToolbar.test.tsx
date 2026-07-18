// @vitest-environment happy-dom

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposerFormattingToolbar } from './ComposerFormattingToolbar'
import { ComposerToolbar } from './ComposerToolbar'

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

// Mirrors how a composer wires the formatting row: a controlled textarea sharing
// value with the toolbar, plus the Aa toggle that shows/hides the row.
function Harness({ initial = '' }: { initial?: string }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const [visible, setVisible] = useState(true)
  const ref = useRef<HTMLTextAreaElement>(null)
  return (
    <div>
      {visible && <ComposerFormattingToolbar textareaRef={ref} value={value} onChange={setValue} />}
      <textarea ref={ref} value={value} onChange={(event) => setValue(event.target.value)} />
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

function render(node: React.JSX.Element): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

function click(selector: string): void {
  const button = container?.querySelector(selector) as HTMLElement
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('ComposerFormattingToolbar', () => {
  it('wraps the current selection in ** and restores the caret around it', () => {
    render(<Harness initial="hello world" />)
    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    textarea.setSelectionRange(6, 11) // select "world"
    click('[aria-label="Bold"]')
    expect(textarea.value).toBe('hello **world**')
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe('world')
  })

  it('prefixes each selected line for an ordered list', () => {
    render(<Harness initial={'one\ntwo'} />)
    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    textarea.setSelectionRange(0, 7)
    click('[aria-label="Ordered list"]')
    expect(textarea.value).toBe('1. one\n2. two')
  })

  it('hides the formatting row when the Aa toggle is pressed', () => {
    render(<Harness />)
    expect(container?.querySelector('[aria-label="Bold"]')).not.toBeNull()
    click('[aria-label="Toggle formatting"]')
    expect(container?.querySelector('[aria-label="Bold"]')).toBeNull()
  })
})
