import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type {
  PieChatMember,
  PieChatRendererApi,
  PieSendMessageOptions
} from '../../../../shared/pie-chat-contract'
import { AttachmentComposer, type PendingAttachment } from './AttachmentComposer'
import { ComposerAttachmentPreview } from './ComposerAttachmentPreview'
import { ComposerToolbar } from './ComposerToolbar'
import { RichChatComposerEditor, type RichChatComposerEditorHandle } from './RichChatComposerEditor'

type ChannelComposerProps = {
  channelId: string
  members: PieChatMember[]
  sending: boolean
  api: PieChatRendererApi
  onSend: (body: string, opts?: PieSendMessageOptions) => void | Promise<void>
  // Emits an ephemeral typing ping for this channel (throttled upstream).
  notifyTyping?: (channelId: string) => void
}

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
  onSend,
  notifyTyping
}: ChannelComposerProps): React.JSX.Element {
  const [empty, setEmpty] = useState(true)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [showFormatting, setShowFormatting] = useState(true)
  const editorRef = useRef<RichChatComposerEditorHandle>(null)

  const canSend = (!empty || attachments.length > 0) && !sending

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
    const body = editorRef.current?.getMarkdown() ?? ''
    const mentionUserIds = editorRef.current?.getMentionUserIds() ?? []
    const opts: PieSendMessageOptions = {}
    if (mentionUserIds.length > 0) {
      opts.mentions = mentionUserIds
    }
    if (attachments.length > 0) {
      opts.attachmentIds = attachments.map((attachment) => attachment.id)
    }
    void onSend(body, Object.keys(opts).length > 0 ? opts : undefined)
    editorRef.current?.clear()
    revokeAttachmentPreviews(attachments)
    setAttachments([])
  }

  return (
    <div className="relative border-t border-border bg-background p-3">
      {/* Single Slack-style container: attachment preview (top, only when non-empty),
          rich editor (middle, auto-grows), toolbar (bottom). Attachments render in
          their own row above the editor so adding or removing a file never resizes
          or displaces it. */}
      <div
        className={cn(
          'flex flex-col rounded-md border border-input bg-background transition-[color,box-shadow]',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50'
        )}
      >
        <ComposerAttachmentPreview attachments={attachments} onRemove={removeAttachment} />
        <RichChatComposerEditor
          ref={editorRef}
          members={members}
          placeholder="Write a message…"
          showFormatting={showFormatting}
          onEmptyChange={setEmpty}
          onType={notifyTyping ? () => notifyTyping(channelId) : undefined}
          onEnterSubmit={submit}
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
            onClick={() => editorRef.current?.triggerMention()}
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
