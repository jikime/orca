import type { PendingAttachment } from './AttachmentComposer'

type ComposerAttachmentPreviewProps = {
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
}

// Renders pending attachments INSIDE the composer container, above the
// textarea, in their own wrapping/scrolling row — this is the fix for the bug
// where AttachmentComposer used to share a flex row with the textarea and Send
// button, so a growing chip row pushed the textarea out of place.
export function ComposerAttachmentPreview({
  attachments,
  onRemove
}: ComposerAttachmentPreviewProps): React.JSX.Element | null {
  if (attachments.length === 0) {
    return null
  }
  return (
    <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto border-b border-border px-2 pt-2 pb-1.5">
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground"
        >
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt="" className="size-6 rounded-sm object-cover" />
          ) : (
            <span aria-hidden>📎</span>
          )}
          <span className="max-w-40 truncate">{attachment.filename}</span>
          <button
            type="button"
            aria-label={`Remove ${attachment.filename}`}
            onClick={() => onRemove(attachment.id)}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  )
}
