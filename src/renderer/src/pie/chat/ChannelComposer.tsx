import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type {
  PieChatMember,
  PieChatRendererApi,
  PieSendMessageOptions
} from '../../../../shared/pie-chat-contract'
import { AttachmentComposer, type PendingAttachment } from './AttachmentComposer'
import { ComposerAttachmentPreview } from './ComposerAttachmentPreview'
import { ComposerToolbar } from './ComposerToolbar'
import { RichChatComposerEditor, type RichChatComposerEditorHandle } from './RichChatComposerEditor'
import { translate } from '@/i18n/i18n'
import { broadcastMentionOptions } from './message-broadcast-mentions'
import {
  chatComposerDraftKey,
  clearChatComposerDraft,
  onChatComposerDraftSent,
  readChatComposerDraft,
  writeChatComposerDraft
} from './chat-composer-draft-store'

type ChannelComposerProps = {
  channelId: string
  draftOwnerId: string
  threadRootMessageId?: string
  members: PieChatMember[]
  sending: boolean
  api: PieChatRendererApi
  onSend: (
    body: string,
    opts?: PieSendMessageOptions,
    clientRequestId?: string
  ) => void | Promise<void>
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
  draftOwnerId,
  threadRootMessageId,
  members,
  sending,
  api,
  onSend,
  notifyTyping
}: ChannelComposerProps): React.JSX.Element {
  const [empty, setEmpty] = useState(true)
  const initialDraft = readChatComposerDraft(
    chatComposerDraftKey(draftOwnerId, channelId, threadRootMessageId)
  )
  const [attachments, setAttachments] = useState<PendingAttachment[]>(
    () => initialDraft?.attachments ?? []
  )
  const [showFormatting, setShowFormatting] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [sendError, setSendError] = useState(false)
  const editorRef = useRef<RichChatComposerEditorHandle>(null)
  const attachmentsRef = useRef(attachments)
  const draftPersistenceActiveRef = useRef(true)
  const hydratedDraftKeyRef = useRef('')
  const retryRequestRef = useRef<{ signature: string; id: string } | null>(null)
  attachmentsRef.current = attachments
  const draftKey = chatComposerDraftKey(draftOwnerId, channelId, threadRootMessageId)
  const draftKeyRef = useRef(draftKey)
  draftKeyRef.current = draftKey

  const canSend = (!empty || attachments.length > 0) && !sending && !submitting

  useEffect(() => {
    const draft = readChatComposerDraft(draftKey)
    revokeAttachmentPreviews(attachmentsRef.current)
    const restoredAttachments = draft?.attachments ?? []
    setAttachments(restoredAttachments)
    attachmentsRef.current = restoredAttachments
    editorRef.current?.setMarkdown(draft?.body ?? '', draft?.mentionUserIds)
    hydratedDraftKeyRef.current = draftKey
  }, [draftKey])

  useEffect(
    () =>
      onChatComposerDraftSent(({ key, clientRequestId }) => {
        if (key !== draftKeyRef.current || retryRequestRef.current?.id !== clientRequestId) {
          return
        }
        clearChatComposerDraft(key)
        editorRef.current?.clear()
        revokeAttachmentPreviews(attachmentsRef.current)
        setAttachments([])
        attachmentsRef.current = []
        retryRequestRef.current = null
        setSendError(false)
      }),
    []
  )

  useEffect(() => {
    draftPersistenceActiveRef.current = true
    return () => {
      // Why: TipTap teardown can emit a final empty update; it must not erase the saved draft.
      draftPersistenceActiveRef.current = false
      revokeAttachmentPreviews(attachmentsRef.current)
    }
  }, [])

  const persistDraft = (
    body: string,
    mentionUserIds: string[],
    nextAttachments = attachmentsRef.current
  ): void => {
    if (!draftPersistenceActiveRef.current || hydratedDraftKeyRef.current !== draftKeyRef.current) {
      return
    }
    writeChatComposerDraft(draftKeyRef.current, {
      body,
      mentionUserIds,
      attachments: nextAttachments,
      updatedAt: new Date().toISOString()
    })
  }

  const updateAttachments = (next: PendingAttachment[]): void => {
    setAttachments(next)
    attachmentsRef.current = next
    persistDraft(
      editorRef.current?.getMarkdown() ?? '',
      editorRef.current?.getMentionUserIds() ?? [],
      next
    )
  }

  const removeAttachment = (id: string): void => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id)
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl)
      }
      const next = current.filter((attachment) => attachment.id !== id)
      attachmentsRef.current = next
      persistDraft(
        editorRef.current?.getMarkdown() ?? '',
        editorRef.current?.getMentionUserIds() ?? [],
        next
      )
      return next
    })
  }

  const submit = (): void => {
    if (!canSend) {
      return
    }
    const body = editorRef.current?.getMarkdown() ?? ''
    const mentionUserIds = editorRef.current?.getMentionUserIds() ?? []
    const broadcastMentions = broadcastMentionOptions(body)
    const opts: PieSendMessageOptions = {}
    if (mentionUserIds.length > 0) {
      opts.mentions = mentionUserIds
    }
    if (attachments.length > 0) {
      opts.attachmentIds = attachments.map((attachment) => attachment.id)
    }
    if (broadcastMentions.mentionChannel) {
      opts.mentionChannel = true
    }
    if (broadcastMentions.mentionHere) {
      opts.mentionHere = true
    }
    const submittedAttachments = attachments
    const submittedKey = draftKey
    const sendOptions = Object.keys(opts).length > 0 ? opts : undefined
    const signature = JSON.stringify([body, sendOptions ?? null])
    const request =
      retryRequestRef.current?.signature === signature
        ? retryRequestRef.current
        : { signature, id: globalThis.crypto.randomUUID() }
    retryRequestRef.current = request
    setSubmitting(true)
    setSendError(false)
    void (async () => {
      try {
        await onSend(body, sendOptions, request.id)
      } catch {
        setSendError(true)
        return
      } finally {
        setSubmitting(false)
      }
      retryRequestRef.current = null
      clearChatComposerDraft(submittedKey)
      // Why: a slow send must not erase edits made while the request was in flight.
      if (
        draftKeyRef.current === submittedKey &&
        editorRef.current?.getMarkdown() === body &&
        attachmentsRef.current.every(
          (attachment, index) => attachment.id === submittedAttachments[index]?.id
        ) &&
        attachmentsRef.current.length === submittedAttachments.length
      ) {
        editorRef.current.clear()
        revokeAttachmentPreviews(submittedAttachments)
        setAttachments([])
        attachmentsRef.current = []
      } else if (draftKeyRef.current === submittedKey) {
        persistDraft(
          editorRef.current?.getMarkdown() ?? '',
          editorRef.current?.getMentionUserIds() ?? []
        )
      }
    })()
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
          key={draftKey}
          ref={editorRef}
          members={members}
          initialMarkdown={initialDraft?.body}
          initialMentionUserIds={initialDraft?.mentionUserIds}
          placeholder={translate('auto.pie.chat.ChannelComposer.34937e0c68', 'Write a message…')}
          showFormatting={showFormatting}
          onEmptyChange={setEmpty}
          onContentChange={persistDraft}
          onType={notifyTyping ? () => notifyTyping(channelId) : undefined}
          onEnterSubmit={submit}
        />
        <ComposerToolbar
          canSend={canSend}
          sending={sending || submitting}
          onSend={submit}
          formattingVisible={showFormatting}
          onToggleFormatting={() => setShowFormatting((current) => !current)}
        >
          <AttachmentComposer
            channelId={channelId}
            api={api}
            attachments={attachments}
            onChange={updateAttachments}
          />
          <button
            type="button"
            onClick={() => editorRef.current?.triggerMention()}
            aria-label={translate('auto.pie.chat.ChannelComposer.882ae59e91', 'Mention someone')}
            className="flex size-8 items-center justify-center rounded-md border border-input text-sm text-muted-foreground hover:bg-accent"
          >
            @
          </button>
        </ComposerToolbar>
      </div>
      {sendError && (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-destructive" role="status">
          <span>
            {translate(
              'auto.pie.chat.ChannelComposer.sendfailed',
              "Message wasn't sent. Your draft is safe."
            )}
          </span>
          <Button type="button" size="xs" variant="ghost" onClick={submit}>
            {translate('auto.pie.chat.ChannelComposer.retry', 'Retry')}
          </Button>
        </div>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        {translate(
          'auto.pie.chat.ChannelComposer.1af09ff097',
          'Enter to send · Shift+Enter for a new line · @ to mention'
        )}
      </p>
    </div>
  )
}
