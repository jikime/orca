import { useState } from 'react'
import type { PieChatRendererApi, PieMessageAttachment } from '../../../../shared/pie-chat-contract'

type AttachmentListProps = {
  channelId: string
  attachments: PieMessageAttachment[]
  api?: PieChatRendererApi
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AttachmentList({
  channelId,
  attachments,
  api = window.api.pie.chat
}: AttachmentListProps): React.JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null)

  // Attachments are served via short-lived presigned GET urls resolved on demand,
  // so we open them lazily rather than embedding a url that would expire.
  const open = async (attachment: PieMessageAttachment): Promise<void> => {
    setBusyId(attachment.id)
    try {
      const download = await api.downloadAttachment(channelId, attachment.id)
      window.open(download.url, '_blank', 'noopener,noreferrer')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mt-1 flex flex-col gap-1">
      {attachments.map((attachment) => (
        <button
          key={attachment.id}
          type="button"
          onClick={() => void open(attachment)}
          disabled={busyId === attachment.id}
          className="flex w-fit max-w-full items-center gap-2 rounded-md border border-border bg-muted px-2 py-1 text-left text-xs text-foreground hover:bg-accent disabled:opacity-50"
        >
          <span aria-hidden>{attachment.contentType.startsWith('image/') ? '🖼️' : '📎'}</span>
          <span className="truncate">{attachment.filename}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(attachment.byteSize)}</span>
        </button>
      ))}
    </div>
  )
}
