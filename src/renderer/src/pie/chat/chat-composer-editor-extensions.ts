import type { AnyExtension } from '@tiptap/core'
import { Mark, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from '@tiptap/markdown'

// Markdown has no underline syntax, so the composer's underline mark serializes
// to a raw <u> tag — the one tag the chat timeline's sanitizer allows on top of
// the safe GitHub schema (see ChatMarkdown's chatSanitizeSchema).
const ChatComposerUnderline = Mark.create({
  name: 'underline',
  parseHTML() {
    return [
      { tag: 'u' },
      {
        style: 'text-decoration',
        consuming: false,
        getAttrs: (style) => ((style as string).includes('underline') ? {} : false)
      }
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return ['u', mergeAttributes(HTMLAttributes), 0]
  },
  // Why: the default underline extension emits `++text++`, which the chat
  // timeline renders literally; <u> is what the timeline sanitizer permits.
  renderMarkdown(node, helpers) {
    return `<u>${helpers.renderChildren(node)}</u>`
  },
  addKeyboardShortcuts() {
    return {
      'Mod-u': () => this.editor.commands.toggleMark(this.name),
      'Mod-U': () => this.editor.commands.toggleMark(this.name)
    }
  }
})

// Live-formatting extension set for the Slack-style chat composer. Deliberately
// lighter than the document RichMarkdownEditor: no images, tables, math, or
// transport codecs — a chat message is a short markdown string.
export function createChatComposerExtensions(placeholder: string): AnyExtension[] {
  return [
    StarterKit.configure({
      // Custom underline serializes to <u>; disable the bundled ++text++ one.
      underline: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true
      }
    }),
    ChatComposerUnderline,
    Placeholder.configure({ placeholder }),
    Markdown.configure({
      markedOptions: {
        gfm: true
      }
    })
  ]
}
