import { useMemo, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import type {
  PieChatMember,
  PieChatRendererApi,
  PieSendMessageOptions
} from '../../../../shared/pie-chat-contract'
import { MentionAutocomplete, filterMembers } from './MentionAutocomplete'
import { AttachmentComposer, type PendingAttachment } from './AttachmentComposer'
import { ComposerAttachmentPreview } from './ComposerAttachmentPreview'
import { ComposerFormattingToolbar } from './ComposerFormattingToolbar'
import { ComposerToolbar } from './ComposerToolbar'
import { useComposerTextareaAutogrow } from './use-composer-textarea-autogrow'

type ChannelComposerProps = {
  channelId: string
  members: PieChatMember[]
  sending: boolean
  api: PieChatRendererApi
  onSend: (body: string, opts?: PieSendMessageOptions) => void | Promise<void>
}

// Matches a mention in progress: a trailing '@word' at the caret with no space.
const TRAILING_MENTION = /(?:^|\s)@([\p{L}\p{N}._-]*)$/u

// Object URLs are only released here (not in AttachmentComposer), since ownership
// of the pending-attachment list — and therefore of when a preview is done — is
// this component's, not the upload control's.
function revokeAttachmentPreviews(attachments: PendingAttachment[]): void {
  attachments.forEach((attachment) => {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl)
    }
  })
}

export function ChannelComposer({
  channelId,
  members,
  sending,
  api,
  onSend
}: ChannelComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [mentionUserIds, setMentionUserIds] = useState<string[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [showFormatting, setShowFormatting] = useState(true)
  const textareaRef = useComposerTextareaAutogrow(value)

  const mentionQuery = useMemo(() => {
    const match = TRAILING_MENTION.exec(value)
    return match ? match[1] : null
  }, [value])
  const matches = mentionQuery === null ? [] : filterMembers(members, mentionQuery)
  const mentionOpen = matches.length > 0

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !sending

  const insertMention = (member: PieChatMember): void => {
    // Replace the trailing '@query' with '@displayName '; record the full user id
    // so the backend receives the real target (display name is a short id slice).
    setValue((current) =>
      current.replace(TRAILING_MENTION, (whole) => {
        const lead = whole.startsWith('@') ? '' : whole[0]
        return `${lead}@${member.displayName} `
      })
    )
    setMentionUserIds((current) =>
      current.includes(member.userId) ? current : [...current, member.userId]
    )
    setActiveIndex(0)
  }

  // Appends a trailing '@' so the existing TRAILING_MENTION-driven autocomplete
  // opens, instead of a decorative button that doesn't do anything real.
  const triggerMention = (): void => {
    setValue((current) =>
      current.length === 0 || current.endsWith(' ') ? `${current}@` : `${current} @`
    )
    textareaRef.current?.focus()
  }

  const removeAttachment = (id: string): void => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id)
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl)
      }
      return current.filter((attachment) => attachment.id !== id)
    })
  }

  const submit = (): void => {
    if (!canSend) {
      return
    }
    const opts: PieSendMessageOptions = {}
    if (mentionUserIds.length > 0) {
      opts.mentions = mentionUserIds
    }
    if (attachments.length > 0) {
      opts.attachmentIds = attachments.map((attachment) => attachment.id)
    }
    void onSend(value, Object.keys(opts).length > 0 ? opts : undefined)
    setValue('')
    revokeAttachmentPreviews(attachments)
    setAttachments([])
    setMentionUserIds([])
    setActiveIndex(0)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mentionOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((index) => (index + 1) % matches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => (index - 1 + matches.length) % matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        insertMention(matches[activeIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setActiveIndex(0)
        return
      }
    }
    // Enter sends; Shift+Enter inserts a newline. No modifier shortcut, so this
    // stays identical across macOS, Linux, and Windows.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="relative border-t border-border bg-background p-3">
      {mentionQuery !== null && (
        <div className="absolute inset-x-3 bottom-full z-10 mb-1">
          <MentionAutocomplete
            members={members}
            query={mentionQuery}
            activeIndex={activeIndex}
            onSelect={insertMention}
          />
        </div>
      )}
      {/* Single Slack-style container: attachment preview (top, only when non-empty),
          textarea (middle, auto-grows), toolbar (bottom). Attachments render in their
          own row above the textarea instead of sharing its flex row, so adding or
          removing a file never resizes or displaces the textarea. */}
      <div
        className={cn(
          'flex flex-col rounded-md border border-input bg-background transition-[color,box-shadow]',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50'
        )}
      >
        <ComposerAttachmentPreview attachments={attachments} onRemove={removeAttachment} />
        {showFormatting && (
          <ComposerFormattingToolbar textareaRef={textareaRef} value={value} onChange={setValue} />
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Write a message…"
          aria-label="Message"
          className={cn(
            'w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-sm text-foreground',
            'placeholder:text-muted-foreground outline-none'
          )}
        />
        <ComposerToolbar
          canSend={canSend}
          sending={sending}
          onSend={submit}
          formattingVisible={showFormatting}
          onToggleFormatting={() => setShowFormatting((current) => !current)}
        >
          <AttachmentComposer
            channelId={channelId}
            api={api}
            attachments={attachments}
            onChange={setAttachments}
          />
          <button
            type="button"
            onClick={triggerMention}
            aria-label="Mention someone"
            className="flex size-8 items-center justify-center rounded-md border border-input text-sm text-muted-foreground hover:bg-accent"
          >
            @
          </button>
        </ComposerToolbar>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Enter to send · Shift+Enter for a new line · @ to mention
      </p>
    </div>
  )
}
