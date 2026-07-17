import { useRef, useState } from 'react'
import type { PieChatRendererApi } from '../../../../shared/pie-chat-contract'

export type PendingAttachment = { id: string; filename: string }

type AttachmentComposerProps = {
  channelId: string
  api: PieChatRendererApi
  attachments: PendingAttachment[]
  onChange: (attachments: PendingAttachment[]) => void
}

// Uploads a picked file via the intent + presigned-PUT flow (both in Main) and
// tracks the returned attachment id so the composer can link it on send.
export function AttachmentComposer({
  channelId,
  api,
  attachments,
  onChange
}: AttachmentComposerProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onPick = async (file: File): Promise<void> => {
    setUploading(true)
    setError(null)
    try {
      const buffer = await file.arrayBuffer()
      const intent = await api.uploadAttachment(
        channelId,
        {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          byteSize: file.size
        },
        buffer
      )
      onChange([...attachments, { id: intent.id, filename: file.name }])
    } catch {
      setError('Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
            >
              <span aria-hidden>📎</span>
              <span className="max-w-40 truncate">{attachment.filename}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.filename}`}
                onClick={() => onChange(attachments.filter((item) => item.id !== attachment.id))}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          aria-label="Attach a file"
          className="flex size-8 items-center justify-center rounded-md border border-input text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          {uploading ? '…' : '📎'}
        </button>
        {error && <span className="text-xs text-destructive">{error}</span>}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              void onPick(file)
            }
            event.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
