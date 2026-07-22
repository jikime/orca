import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { PieChatMember } from '../../../../shared/pie-chat-contract'
import { MentionAutocomplete, filterMembers } from './MentionAutocomplete'
import { ComposerFormattingToolbar } from './ComposerFormattingToolbar'
import { createChatComposerExtensions } from './chat-composer-editor-extensions'

// Matches a mention in progress: a trailing '@word' at the caret with no space.
const TRAILING_MENTION = /(?:^|\s)@([\p{L}\p{N}._-]*)$/u
const EMPTY_MENTION_USER_IDS: string[] = []

export type RichChatComposerEditorHandle = {
  // Serialize the live rich content to the markdown string sendMessage expects.
  getMarkdown: () => string
  getMentionUserIds: () => string[]
  setMarkdown: (markdown: string, mentionUserIds?: string[]) => void
  clear: () => void
  focus: () => void
  triggerMention: () => void
}

type MentionState = {
  query: string
  matches: PieChatMember[]
  activeIndex: number
}

type RichChatComposerEditorProps = {
  members: PieChatMember[]
  initialMarkdown?: string
  initialMentionUserIds?: string[]
  disabled?: boolean
  placeholder: string
  showFormatting: boolean
  // Reports whether the editor has no sendable content, so the parent gates Send.
  onEmptyChange: (empty: boolean) => void
  // Fired on every content change, so the parent can emit an ephemeral typing ping
  // (the parent/backend throttle it; here it just signals "the user is typing").
  onType?: () => void
  onContentChange?: (markdown: string, mentionUserIds: string[]) => void
  // Fired on Enter (no Shift, no open mention popup) — the parent runs its send.
  onEnterSubmit: () => void
  // Lifecycle passthrough for autofocus/tests; the editor stays self-owned.
  onCreate?: (editor: Editor) => void
}

function readMentionQuery(editor: Editor): string | null {
  const { from } = editor.state.selection
  const textBefore = editor.state.doc.textBetween(Math.max(0, from - 120), from, '\n', '\n')
  const match = TRAILING_MENTION.exec(textBefore)
  return match ? match[1] : null
}

export const RichChatComposerEditor = forwardRef<
  RichChatComposerEditorHandle,
  RichChatComposerEditorProps
>(function RichChatComposerEditor(
  {
    members,
    initialMarkdown = '',
    initialMentionUserIds = EMPTY_MENTION_USER_IDS,
    disabled = false,
    placeholder,
    showFormatting,
    onEmptyChange,
    onType,
    onContentChange,
    onEnterSubmit,
    onCreate
  },
  ref
): React.JSX.Element {
  const [mention, setMention] = useState<MentionState | null>(null)
  const selectedMentions = useRef(new Map<string, string>())
  const editorRef = useRef<Editor | null>(null)

  // Refs mirror the values the once-bound ProseMirror keydown handler must read
  // fresh, avoiding stale closures.
  const mentionRef = useRef<MentionState | null>(null)
  const onEnterSubmitRef = useRef(onEnterSubmit)
  const onTypeRef = useRef(onType)
  const onContentChangeRef = useRef(onContentChange)
  const membersRef = useRef(members)
  onEnterSubmitRef.current = onEnterSubmit
  onTypeRef.current = onType
  onContentChangeRef.current = onContentChange
  membersRef.current = members
  mentionRef.current = mention

  const selectedMentionUserIds = useCallback((activeEditor: Editor): string[] => {
    const markdown = activeEditor.getMarkdown()
    return [...selectedMentions.current]
      .filter(([, displayName]) => markdown.includes(`@${displayName}`))
      .map(([userId]) => userId)
  }, [])

  const extensions = useMemo(() => createChatComposerExtensions(placeholder), [placeholder])

  const syncMention = useCallback((activeEditor: Editor): void => {
    const query = readMentionQuery(activeEditor)
    if (query === null) {
      setMention(null)
      return
    }
    const matches = filterMembers(membersRef.current, query)
    if (matches.length === 0) {
      setMention(null)
      return
    }
    setMention((prev) => ({
      query,
      matches,
      activeIndex: prev && prev.query === query ? Math.min(prev.activeIndex, matches.length - 1) : 0
    }))
  }, [])

  const selectMention = useCallback((member: PieChatMember): void => {
    const editor = editorRef.current
    if (!editor) {
      return
    }
    const { from } = editor.state.selection
    const textBefore = editor.state.doc.textBetween(Math.max(0, from - 120), from, '\n', '\n')
    const match = TRAILING_MENTION.exec(textBefore)
    if (!match) {
      return
    }
    // Replace the trailing '@query' (query + the '@') with '@displayName '; the
    // full user id is recorded so the backend gets the real mention target.
    const deleteLength = match[1].length + 1
    selectedMentions.current.set(member.userId, member.displayName)
    editor
      .chain()
      .focus()
      .deleteRange({ from: from - deleteLength, to: from })
      .insertContent({ type: 'text', text: `@${member.displayName} ` })
      .run()
    setMention(null)
  }, [])

  const editor = useEditor({
    extensions,
    editable: !disabled,
    editorProps: {
      attributes: {
        class: cn(
          'chat-composer-content max-h-48 min-h-[1.5rem] w-full overflow-y-auto',
          'whitespace-pre-wrap break-words px-3 py-2 text-sm text-foreground outline-none'
        ),
        'aria-label': translate('auto.pie.chat.RichChatComposerEditor.arialabel', 'Message')
      },
      handleKeyDown: (_view, event) => {
        const current = mentionRef.current
        if (current && current.matches.length > 0) {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setMention((state) =>
              state
                ? { ...state, activeIndex: (state.activeIndex + 1) % state.matches.length }
                : state
            )
            return true
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setMention((state) =>
              state
                ? {
                    ...state,
                    activeIndex:
                      (state.activeIndex - 1 + state.matches.length) % state.matches.length
                  }
                : state
            )
            return true
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            selectMention(current.matches[current.activeIndex])
            return true
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setMention(null)
            return true
          }
        }
        // Enter sends; Shift+Enter falls through to TipTap's hard break. Skip
        // while composing (IME) so Enter confirming a candidate never sends.
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault()
          onEnterSubmitRef.current()
          return true
        }
        return false
      }
    },
    onCreate: ({ editor: created }) => {
      for (const userId of initialMentionUserIds) {
        const member = membersRef.current.find((candidate) => candidate.userId === userId)
        if (member) {
          selectedMentions.current.set(userId, member.displayName)
        }
      }
      if (initialMarkdown) {
        created.commands.setContent(initialMarkdown, { contentType: 'markdown' })
      }
      onEmptyChange(created.isEmpty)
      onCreate?.(created)
    },
    onUpdate: ({ editor: updated }) => {
      const empty = updated.getText().trim().length === 0
      onEmptyChange(empty)
      // Only signal typing on real content (not a clear/backspace-to-empty).
      if (!empty) {
        onTypeRef.current?.()
      }
      onContentChangeRef.current?.(updated.getMarkdown().trimEnd(), selectedMentionUserIds(updated))
      syncMention(updated)
    },
    onSelectionUpdate: ({ editor: updated }) => {
      syncMention(updated)
    }
  })

  editorRef.current = editor

  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled)
    }
  }, [editor, disabled])

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => editorRef.current?.getMarkdown().trimEnd() ?? '',
      getMentionUserIds: () => {
        const active = editorRef.current
        return active ? selectedMentionUserIds(active) : []
      },
      setMarkdown: (markdown, mentionUserIds = []) => {
        const active = editorRef.current
        if (!active) {
          return
        }
        selectedMentions.current.clear()
        for (const userId of mentionUserIds) {
          const member = membersRef.current.find((candidate) => candidate.userId === userId)
          if (member) {
            selectedMentions.current.set(userId, member.displayName)
          }
        }
        active.commands.setContent(markdown, { contentType: 'markdown' })
        onEmptyChange(active.getText().trim().length === 0)
      },
      clear: () => {
        editorRef.current?.commands.clearContent()
        selectedMentions.current.clear()
        setMention(null)
        onEmptyChange(true)
      },
      focus: () => {
        editorRef.current?.commands.focus()
      },
      triggerMention: () => {
        const active = editorRef.current
        if (!active) {
          return
        }
        // Append '@' (with a leading space when needed) so trailing-mention
        // detection opens the same popup as typing '@' by hand.
        const text = active.getText()
        const needsSpace = text.length > 0 && !text.endsWith(' ') && !text.endsWith('\n')
        active
          .chain()
          .focus()
          .insertContent({ type: 'text', text: needsSpace ? ' @' : '@' })
          .run()
      }
    }),
    [onEmptyChange, selectedMentionUserIds]
  )

  return (
    <>
      {showFormatting && !disabled && <ComposerFormattingToolbar editor={editor} />}
      <div className="relative">
        {mention && (
          <div className="absolute inset-x-0 bottom-full z-10 mb-1">
            <MentionAutocomplete
              members={members}
              query={mention.query}
              activeIndex={mention.activeIndex}
              onSelect={selectMention}
            />
          </div>
        )}
        <EditorContent
          editor={editor}
          className={cn(disabled && 'cursor-not-allowed opacity-50')}
        />
      </div>
    </>
  )
})
