import { useRef, useState } from 'react'
import type { PieChatRendererApi } from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'

export type PendingAttachment = {
  id: string
  filename: string
  contentType?: string
  // Local object URL for an image file, set only when the File object was
  // available at upload time; ComposerAttachmentPreview renders it as a thumbnail.
  previewUrl?: string
}

type AttachmentComposerProps = {
  channelId: string
  api: PieChatRendererApi
  attachments: PendingAttachment[]
  onChange: (attachments: PendingAttachment[]) => void
}

// The attach button + hidden file input. Uploads a picked file via the intent +
// presigned-PUT flow (both in Main) and tracks the returned attachment id so the
// composer can link it on send. Rendering of pending attachments lives in
// ComposerAttachmentPreview so this stays a pure "pick + upload" control.
export function AttachmentComposer({
  channelId,
  api,
  attachments,
  onChange
}: AttachmentComposerProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failedFile, setFailedFile] = useState<File | null>(null)

  const onPick = async (file: File): Promise<void> => {
    setUploading(true)
    setError(null)
    setFailedFile(null)
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
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
      onChange([
        ...attachments,
        { id: intent.id, filename: file.name, contentType: file.type, previewUrl }
      ])
    } catch {
      setError(translate('auto.pie.chat.AttachmentComposer.uploadfailed', 'Upload failed'))
      setFailedFile(file)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        aria-label={translate('auto.pie.chat.AttachmentComposer.2cfdefee37', 'Attach a file')}
        className="flex size-8 items-center justify-center rounded-md border border-input text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
      >
        {uploading ? '…' : '📎'}
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
      {failedFile && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={uploading}
          onClick={() => void onPick(failedFile)}
        >
          {translate('auto.pie.chat.AttachmentComposer.retry', 'Retry')}
        </Button>
      )}
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
  )
}
