import type { Editor } from '@tiptap/core'
import {
  Bold,
  Code,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Smile,
  Strikethrough,
  Underline
} from 'lucide-react'
import { Toggle } from '@/components/ui/toggle'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getShortcutPlatform } from '@/lib/shortcut-platform'

type ComposerFormattingToolbarProps = {
  editor: Editor | null
}

// Dependency-free quick set, mirroring ReactionBar's approach (no emoji-mart).
const QUICK_EMOJIS = ['😀', '😂', '👍', '🎉', '❤️', '🙏', '✅', '🚀']

// Platform-aware modifier label so tooltips read ⌘B on macOS, Ctrl+B elsewhere.
function modLabel(): string {
  return getShortcutPlatform() === 'darwin' ? '⌘' : 'Ctrl+'
}

// Live-formatting toolbar: buttons toggle real TipTap marks/nodes so the
// message renders WYSIWYG. Serialization back to markdown happens on send.
export function ComposerFormattingToolbar({
  editor
}: ComposerFormattingToolbarProps): React.JSX.Element {
  const mod = modLabel()

  const promptForLink = (): void => {
    if (!editor) {
      return
    }
    if (editor.isActive('link')) {
      editor.chain().focus().unsetLink().run()
      return
    }
    const url = globalThis.prompt?.('Link URL')
    if (!url) {
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  return (
    <div className="flex items-center gap-0.5 border-b border-border px-2 py-1">
      <Toggle
        size="sm"
        pressed={editor?.isActive('bold') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleBold().run()}
        aria-label="Bold"
        title={`Bold (${mod}B)`}
      >
        <Bold />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor?.isActive('italic') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleItalic().run()}
        aria-label="Italic"
        title={`Italic (${mod}I)`}
      >
        <Italic />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor?.isActive('underline') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleMark('underline').run()}
        aria-label="Underline"
        title={`Underline (${mod}U)`}
      >
        <Underline />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor?.isActive('strike') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleStrike().run()}
        aria-label="Strikethrough"
        title="Strikethrough"
      >
        <Strikethrough />
      </Toggle>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <Toggle
        size="sm"
        pressed={editor?.isActive('link') ?? false}
        onPressedChange={promptForLink}
        aria-label="Link"
        title="Link"
      >
        <LinkIcon />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor?.isActive('orderedList') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleOrderedList().run()}
        aria-label="Ordered list"
        title="Ordered list"
      >
        <ListOrdered />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor?.isActive('bulletList') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleBulletList().run()}
        aria-label="Unordered list"
        title="Bulleted list"
      >
        <List />
      </Toggle>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <Toggle
        size="sm"
        pressed={editor?.isActive('codeBlock') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleCodeBlock().run()}
        aria-label="Code block"
        title="Code block"
      >
        <Code />
      </Toggle>
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
                onClick={() => editor?.chain().focus().insertContent(emoji).run()}
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
