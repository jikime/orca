// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageBody } from './MessageBody'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(body: string): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<MessageBody body={body} />)
  })
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('MessageBody markdown', () => {
  it('renders bold as <strong>', () => {
    render('**bold**')
    const strong = container?.querySelector('strong')
    expect(strong?.textContent).toBe('bold')
  })

  it('renders italic as <em>', () => {
    render('*italic*')
    expect(container?.querySelector('em')?.textContent).toBe('italic')
  })

  it('renders strikethrough as <del>', () => {
    render('~~gone~~')
    expect(container?.querySelector('del')?.textContent).toBe('gone')
  })

  it('renders inline code as <code>', () => {
    render('`snippet`')
    const code = container?.querySelector('code')
    expect(code?.textContent).toBe('snippet')
    expect(container?.querySelector('pre')).toBeNull()
  })

  it('renders a fenced block as <pre>', () => {
    render('```\nconst a = 1\n```')
    const pre = container?.querySelector('pre')
    expect(pre?.textContent).toContain('const a = 1')
  })

  it('renders a bulleted list as <ul><li>', () => {
    render('- a\n- b')
    const items = container?.querySelectorAll('ul li')
    expect(items?.length).toBe(2)
    expect(items?.[0].textContent).toBe('a')
  })

  it('renders a link with safe target and rel', () => {
    render('[t](https://example.com)')
    const anchor = container?.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://example.com')
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders <u> underline emitted by the toolbar', () => {
    render('<u>under</u>')
    expect(container?.querySelector('u')?.textContent).toBe('under')
  })
})

describe('MessageBody security', () => {
  it('does not produce a javascript: href', () => {
    render('[x](javascript:alert(1))')
    const anchor = container?.querySelector('a')
    const href = anchor?.getAttribute('href') ?? ''
    expect(href.toLowerCase()).not.toContain('javascript:')
  })

  it('strips a raw <script> tag', () => {
    render('hi <script>alert(1)</script> there')
    expect(container?.querySelector('script')).toBeNull()
    expect(container?.innerHTML.toLowerCase()).not.toContain('<script')
  })

  it('strips an onerror handler from a raw <img>', () => {
    render('<img src=x onerror="alert(1)">')
    const img = container?.querySelector('img')
    expect(img?.getAttribute('onerror')).toBeNull()
    expect(container?.innerHTML.toLowerCase()).not.toContain('onerror')
  })
})

describe('MessageBody mention highlighting', () => {
  it('highlights an @mention with the mention pill style', () => {
    render('hey @alice')
    const spans = Array.from(container?.querySelectorAll('span') ?? [])
    const mention = spans.find((span) => span.textContent === '@alice')
    expect(mention).toBeTruthy()
    expect(mention?.className).toContain('bg-primary/10')
    expect(mention?.className).toContain('text-primary')
  })

  it('highlights a #channel with the channel style', () => {
    render('see #general')
    const spans = Array.from(container?.querySelectorAll('span') ?? [])
    const channel = spans.find((span) => span.textContent === '#general')
    expect(channel).toBeTruthy()
    expect(channel?.className).toContain('text-primary')
    expect(channel?.className).not.toContain('bg-primary/10')
  })

  it('highlights a mention adjacent to markdown', () => {
    render('**hi** @bob')
    expect(container?.querySelector('strong')?.textContent).toBe('hi')
    const spans = Array.from(container?.querySelectorAll('span') ?? [])
    expect(spans.some((span) => span.textContent === '@bob')).toBe(true)
  })

  it('does not highlight a mention inside inline code', () => {
    render('`@alice`')
    const code = container?.querySelector('code')
    expect(code?.textContent).toBe('@alice')
    expect(code?.querySelector('span')).toBeNull()
  })
})

describe('MessageBody plain text', () => {
  it('renders a plain message unchanged', () => {
    render('just a normal message')
    expect(container?.textContent).toBe('just a normal message')
  })
})
