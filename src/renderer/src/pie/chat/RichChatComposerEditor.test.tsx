// @vitest-environment happy-dom

import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { RichChatComposerEditor, type RichChatComposerEditorHandle } from './RichChatComposerEditor'
import type { PieChatMember } from '../../../../shared/pie-chat-contract'

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

const MEMBERS = [
  { userId: 'u-1-abc', displayName: 'Ada' },
  { userId: 'u-2-def', displayName: 'Grace' }
] as unknown as PieChatMember[]

type Overrides = Partial<React.ComponentProps<typeof RichChatComposerEditor>>

async function render(overrides: Overrides = {}): Promise<{
  ref: React.RefObject<RichChatComposerEditorHandle | null>
  editor: () => Editor
}> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const ref = createRef<RichChatComposerEditorHandle>()
  let editor: Editor | null = null
  await act(async () => {
    root?.render(
      <RichChatComposerEditor
        ref={ref}
        members={MEMBERS}
        placeholder="Write a message…"
        showFormatting
        onEmptyChange={overrides.onEmptyChange ?? vi.fn()}
        onEnterSubmit={overrides.onEnterSubmit ?? vi.fn()}
        disabled={overrides.disabled}
        onCreate={(created) => {
          editor = created
        }}
      />
    )
  })
  // The editor is created in an effect; flush it before returning.
  await act(async () => {
    await Promise.resolve()
  })
  return { ref, editor: () => editor as Editor }
}

function setHtml(editor: Editor, html: string): void {
  act(() => {
    editor.commands.setContent(html, { contentType: 'html' })
    editor.commands.focus('end')
  })
}

function contentEl(): HTMLElement {
  return container?.querySelector('[contenteditable]') as HTMLElement
}

function pressEnter(shiftKey = false): void {
  act(() => {
    contentEl().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true })
    )
  })
}

describe('RichChatComposerEditor markdown round-trip', () => {
  it.each([
    ['bold', '<p><strong>hi</strong></p>', '**hi**'],
    ['italic', '<p><em>hi</em></p>', '*hi*'],
    ['strike', '<p><s>hi</s></p>', '~~hi~~'],
    ['link', '<p><a href="https://x.io">t</a></p>', '[t](https://x.io)'],
    ['bullet list', '<ul><li>a</li><li>b</li></ul>', '- a\n- b'],
    ['ordered list', '<ol><li>a</li><li>b</li></ol>', '1. a\n2. b'],
    ['inline code', '<p><code>x</code></p>', '`x`'],
    ['code block', '<pre><code>x=1</code></pre>', '```\nx=1\n```']
  ])('serializes %s to markdown', async (_name, html, expected) => {
    const { ref, editor } = await render()
    setHtml(editor(), html)
    expect(ref.current?.getMarkdown()).toBe(expected)
  })

  it('serializes underline to a <u> tag, not markdown ++', async () => {
    const { ref, editor } = await render()
    setHtml(editor(), '<p><u>hi</u></p>')
    expect(ref.current?.getMarkdown()).toBe('<u>hi</u>')
  })

  it('reads the markdown the parent would send on Enter', async () => {
    let sent = ''
    const { ref, editor } = await render({
      onEnterSubmit: () => {
        sent = ref.current?.getMarkdown() ?? ''
      }
    })
    setHtml(editor(), '<p><strong>ship it</strong></p>')
    pressEnter()
    expect(sent).toBe('**ship it**')
  })
})

describe('RichChatComposerEditor send keys and guards', () => {
  it('submits on Enter', async () => {
    const onEnterSubmit = vi.fn()
    const { editor } = await render({ onEnterSubmit })
    setHtml(editor(), '<p>hey</p>')
    pressEnter()
    expect(onEnterSubmit).toHaveBeenCalledTimes(1)
  })

  it('does not submit on Shift+Enter', async () => {
    const onEnterSubmit = vi.fn()
    const { editor } = await render({ onEnterSubmit })
    setHtml(editor(), '<p>hey</p>')
    pressEnter(true)
    expect(onEnterSubmit).not.toHaveBeenCalled()
  })

  it('reports empty content and yields an empty markdown string when blank', async () => {
    const onEmptyChange = vi.fn()
    const { ref } = await render({ onEmptyChange })
    expect(onEmptyChange).toHaveBeenLastCalledWith(true)
    expect(ref.current?.getMarkdown()).toBe('')
  })

  it('clears content on request', async () => {
    const { ref, editor } = await render()
    setHtml(editor(), '<p>draft</p>')
    expect(ref.current?.getMarkdown()).toBe('draft')
    act(() => ref.current?.clear())
    expect(ref.current?.getMarkdown()).toBe('')
  })

  it('renders a read-only surface when disabled', async () => {
    await render({ disabled: true })
    expect(contentEl().getAttribute('contenteditable')).toBe('false')
  })
})

describe('RichChatComposerEditor mentions', () => {
  it('opens the autocomplete for a trailing @query and inserts the pick', async () => {
    const { ref, editor } = await render()
    setHtml(editor(), '<p>hi @Ad</p>')
    const option = container?.querySelector('[role="option"]') as HTMLElement
    expect(option.textContent).toContain('Ada')
    act(() => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })
    expect(ref.current?.getMarkdown()).toContain('@Ada')
    expect(ref.current?.getMentionUserIds()).toEqual(['u-1-abc'])
  })

  it('triggerMention opens the popup from an imperative call', async () => {
    const { ref, editor } = await render()
    setHtml(editor(), '<p>hi</p>')
    act(() => ref.current?.triggerMention())
    const options = container?.querySelectorAll('[role="option"]')
    expect(options && options.length).toBeGreaterThan(0)
  })
})
