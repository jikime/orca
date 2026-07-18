import React from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { cn } from '@/lib/utils'

type MarkdownRehypePlugins = NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']>

type HastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

// Highlights @mention and #channel tokens the composer inserted. Mirrors the
// old plain-text regex; start-of-node or whitespace must precede the token.
const MENTION_TOKEN = /(^|\s)([@#][\p{L}\p{N}._-]+)/gu

// Why: don't rewrite tokens inside code/links — there they are literal text.
const MENTION_SKIP_TAGS = new Set(['a', 'code', 'pre'])

function createMentionSpan(token: string): HastNode {
  const isMention = token.startsWith('@')
  return {
    type: 'element',
    tagName: 'span',
    // Match the composer's token style: filled pill for @, tint for #.
    properties: {
      className: cn('rounded px-0.5', isMention ? 'bg-primary/10 text-primary' : 'text-primary')
    },
    children: [{ type: 'text', value: token }]
  }
}

function splitMentionText(value: string): HastNode[] {
  const parts: HastNode[] = []
  let cursor = 0
  for (const match of value.matchAll(MENTION_TOKEN)) {
    const token = match[2]
    const start = (match.index ?? 0) + match[1].length
    if (start > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, start) })
    }
    parts.push(createMentionSpan(token))
    cursor = start + token.length
  }
  if (cursor === 0) {
    return [{ type: 'text', value }]
  }
  if (cursor < value.length) {
    parts.push({ type: 'text', value: value.slice(cursor) })
  }
  return parts
}

function highlightMentionsInTree(node: HastNode): void {
  if (!node.children) {
    return
  }
  const next: HastNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      for (const part of splitMentionText(child.value)) {
        next.push(part)
      }
    } else {
      if (!(child.tagName && MENTION_SKIP_TAGS.has(child.tagName))) {
        highlightMentionsInTree(child)
      }
      next.push(child)
    }
  }
  node.children = next
}

// Why: mention spans carry classes sanitize would drop, so this runs AFTER
// rehypeSanitize — it only wraps already-safe text nodes, adding no new markup
// risk. Keeping highlighting inside the hast tree means it survives markdown
// parsing (bold/links/etc.) instead of being lost on a raw-string pass.
function rehypeMentionHighlight(): (tree: HastNode) => void {
  return (tree) => highlightMentionsInTree(tree)
}

// Why: message bodies are UNTRUSTED user input. Start from the safe GitHub
// schema and allow only the composer's underline tag on top of it, so raw HTML
// like <script> / <img onerror> / javascript: URLs is still stripped.
const chatSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'u'],
  attributes: {
    ...defaultSchema.attributes,
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align']
  }
}

// Why: the toolbar's underline button emits inline <u>…</u>; parse raw HTML
// then sanitize it immediately, before the mention pass and before React.
const chatRehypePlugins: MarkdownRehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, chatSanitizeSchema],
  rehypeMentionHighlight
]

// remark-breaks: a single newline becomes a line break, matching chat input.
const chatRemarkPlugins = [remarkGfm, remarkBreaks]

// Compact, chat-density renderers styled with design-system tokens.
const chatMarkdownComponents: Components = {
  // Paragraphs render inline so a one-line message (and a trailing "(edited)")
  // stays on one line, exactly like the old plain-text body.
  p: ({ children }) => <span className="chat-md-p">{children}</span>,
  a: ({ href, children }) => (
    <a
      href={href || undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </a>
  ),
  // react-markdown uses this for inline `code` and <code> inside <pre>; the
  // wrapper below strips the pill styling when it sits in a fenced block.
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-px font-mono text-[0.85em] [overflow-wrap:anywhere]">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-1 max-h-64 max-w-full overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-0.5 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-0.5 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => (
    <li className="leading-normal [&>input]:pointer-events-none">{children}</li>
  ),
  // chat-compact-headings: no page hierarchy in a message row — render small + bold.
  h1: ({ children }) => <span className="font-semibold">{children}</span>,
  h2: ({ children }) => <span className="font-semibold">{children}</span>,
  h3: ({ children }) => <span className="font-semibold">{children}</span>,
  h4: ({ children }) => <span className="font-semibold">{children}</span>,
  h5: ({ children }) => <span className="font-semibold">{children}</span>,
  h6: ({ children }) => <span className="font-semibold">{children}</span>,
  hr: () => <hr className="my-1 border-border/60" />,
  blockquote: ({ children }) => (
    <blockquote className="my-0.5 border-l-2 border-border/60 pl-2 text-muted-foreground">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-1 max-w-full overflow-x-auto">
      <table className="border-collapse text-xs [&_td]:border [&_td]:border-border/40 [&_td]:px-1.5 [&_td]:py-0.5 [&_th]:border [&_th]:border-border/40 [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left [&_th]:font-semibold">
        {children}
      </table>
    </div>
  )
}

export function ChatMarkdown({ body }: { body: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        // Strip the inline-code pill inside fenced blocks (higher specificity
        // than the utilities on <code>).
        '[&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0'
      )}
    >
      <Markdown
        remarkPlugins={chatRemarkPlugins}
        rehypePlugins={chatRehypePlugins}
        components={chatMarkdownComponents}
      >
        {body}
      </Markdown>
    </span>
  )
}
