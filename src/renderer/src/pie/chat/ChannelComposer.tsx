import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  PieChatMember,
  PieChatRendererApi,
  PieSendMessageOptions
} from '../../../../shared/pie-chat-contract'
import { MentionAutocomplete, filterMembers } from './MentionAutocomplete'
import { AttachmentComposer, type PendingAttachment } from './AttachmentComposer'

type ChannelComposerProps = {
  channelId: string
  members: PieChatMember[]
  sending: boolean
  api: PieChatRendererApi
  onSend: (body: string, opts?: PieSendMessageOptions) => void | Promise<void>
}

// Matches a mention in progress: a trailing '@word' at the caret with no space.
const TRAILING_MENTION = /(?:^|\s)@([\p{L}\p{N}._-]*)$/u

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
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
    <div className="border-t border-border bg-background p-3">
      {mentionQuery !== null && (
        <MentionAutocomplete
          members={members}
          query={mentionQuery}
          activeIndex={activeIndex}
          onSelect={insertMention}
        />
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
          'w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground',
          'placeholder:text-muted-foreground outline-none transition-[color,box-shadow]',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
        )}
      />
      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
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
        </div>
        <Button type="button" size="sm" onClick={submit} disabled={!canSend}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Enter to send · Shift+Enter for a new line · @ to mention
      </p>
    </div>
  )
}
