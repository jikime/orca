import { useLayoutEffect, useRef, type RefObject } from 'react'
import {
  Bold,
  Code,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Smile,
  Strikethrough,
  Underline
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { insertText, prefixLines, wrapSelection, type MarkdownEdit } from './composer-markdown-insert'

type ComposerFormattingToolbarProps = {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
}

// Dependency-free quick set, mirroring ReactionBar's approach (no emoji-mart).
const QUICK_EMOJIS = ['😀', '😂', '👍', '🎉', '❤️', '🙏', '✅', '🚀']

// Markdown has no underline, so the Underline button emits an inline <u> tag —
// the one place the composer's plain markdown leans on raw HTML.
export function ComposerFormattingToolbar({
  textareaRef,
  value,
  onChange
}: ComposerFormattingToolbarProps): React.JSX.Element {
  // Selection to restore once the controlled textarea re-renders with the new
  // value. A layout effect applies it before paint so the caret never flickers.
  const pendingSelection = useRef<{ start: number; end: number } | null>(null)

  useLayoutEffect(() => {
    const target = textareaRef.current
    const selection = pendingSelection.current
    if (target && selection) {
      target.focus()
      target.setSelectionRange(selection.start, selection.end)
      pendingSelection.current = null
    }
  })

  const apply = (edit: (value: string, start: number, end: number) => MarkdownEdit): void => {
    const target = textareaRef.current
    if (!target) {
      return
    }
    const result = edit(value, target.selectionStart, target.selectionEnd)
    pendingSelection.current = { start: result.selectionStart, end: result.selectionEnd }
    onChange(result.value)
  }

  const wrap = (before: string, after: string): void => {
    apply((v, start, end) => wrapSelection(v, start, end, before, after))
  }

  return (
    <div className="flex items-center gap-0.5 border-b border-border px-2 py-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => wrap('**', '**')}
        aria-label="Bold"
      >
        <Bold />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => wrap('*', '*')}
        aria-label="Italic"
      >
        <Italic />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => wrap('<u>', '</u>')}
        aria-label="Underline"
      >
        <Underline />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => wrap('~~', '~~')}
        aria-label="Strikethrough"
      >
        <Strikethrough />
      </Button>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => wrap('[', '](url)')}
        aria-label="Link"
      >
        <LinkIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => apply((v, start, end) => prefixLines(v, start, end, (index) => `${index + 1}. `))}
        aria-label="Ordered list"
      >
        <ListOrdered />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => apply((v, start, end) => prefixLines(v, start, end, () => '- '))}
        aria-label="Unordered list"
      >
        <List />
      </Button>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => apply((v, start, end) => prefixLines(v, start, end, () => '  '))}
        aria-label="Indent"
      >
        <IndentIncrease />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => wrap('```\n', '\n```')}
        aria-label="Code block"
      >
        <Code />
      </Button>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Emoji">
            <Smile />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-1" align="start">
          <div className="flex gap-0.5">
            {QUICK_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => apply((v, start, end) => insertText(v, start, end, emoji))}
                aria-label={`Insert ${emoji}`}
                className="flex size-8 items-center justify-center rounded-md text-base hover:bg-accent"
              >
                {emoji}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
