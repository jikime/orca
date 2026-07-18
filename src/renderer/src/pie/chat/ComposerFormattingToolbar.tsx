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
import { translate } from '@/i18n/i18n'

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
    const url = globalThis.prompt?.(
      translate('auto.pie.chat.ComposerFormattingToolbar.fce63e588e', 'Link URL')
    )
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
        aria-label={translate('auto.pie.chat.ComposerFormattingToolbar.03d76cb53b', 'Bold')}
        title={translate(
          'auto.pie.chat.ComposerFormattingToolbar.55d75f9b6a',
          'Bold ({{value0}}B)',
          { value0: mod }
        )}
      >
        <Bold />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor?.isActive('italic') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleItalic().run()}
        aria-label={translate('auto.pie.chat.ComposerFormattingToolbar.86e7920051', 'Italic')}
        title={translate(
          'auto.pie.chat.ComposerFormattingToolbar.d23ea3e657',
          'Italic ({{value0}}I)',
          { value0: mod }
        )}
      >
        <Italic />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor?.isActive('underline') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleMark('underline').run()}
        aria-label={translate('auto.pie.chat.ComposerFormattingToolbar.755dce67eb', 'Underline')}
        title={translate(
          'auto.pie.chat.ComposerFormattingToolbar.aa643a0f4c',
          'Underline ({{value0}}U)',
          { value0: mod }
        )}
      >
        <Underline />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor?.isActive('strike') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleStrike().run()}
        aria-label={translate(
          'auto.pie.chat.ComposerFormattingToolbar.138e85856a',
          'Strikethrough'
        )}
        title={translate('auto.pie.chat.ComposerFormattingToolbar.138e85856a', 'Strikethrough')}
      >
        <Strikethrough />
      </Toggle>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <Toggle
        size="sm"
        pressed={editor?.isActive('link') ?? false}
        onPressedChange={promptForLink}
        aria-label={translate('auto.pie.chat.ComposerFormattingToolbar.4833d75420', 'Link')}
        title={translate('auto.pie.chat.ComposerFormattingToolbar.4833d75420', 'Link')}
      >
        <LinkIcon />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor?.isActive('orderedList') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleOrderedList().run()}
        aria-label={translate('auto.pie.chat.ComposerFormattingToolbar.90b200f199', 'Ordered list')}
        title={translate('auto.pie.chat.ComposerFormattingToolbar.90b200f199', 'Ordered list')}
      >
        <ListOrdered />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor?.isActive('bulletList') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleBulletList().run()}
        aria-label={translate(
          'auto.pie.chat.ComposerFormattingToolbar.57764bef33',
          'Unordered list'
        )}
        title={translate('auto.pie.chat.ComposerFormattingToolbar.bca81fd69b', 'Bulleted list')}
      >
        <List />
      </Toggle>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <Toggle
        size="sm"
        pressed={editor?.isActive('codeBlock') ?? false}
        onPressedChange={() => editor?.chain().focus().toggleCodeBlock().run()}
        aria-label={translate('auto.pie.chat.ComposerFormattingToolbar.09454cd357', 'Code block')}
        title={translate('auto.pie.chat.ComposerFormattingToolbar.09454cd357', 'Code block')}
      >
        <Code />
      </Toggle>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={translate('auto.pie.chat.ComposerFormattingToolbar.9357dca58b', 'Emoji')}
          >
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
                aria-label={translate(
                  'auto.pie.chat.ComposerFormattingToolbar.bad7b0e4c0',
                  'Insert {{value0}}',
                  { value0: emoji }
                )}
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
