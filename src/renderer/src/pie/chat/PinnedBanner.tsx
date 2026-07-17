import { useEffect, useState } from 'react'
import type { PieChatRendererApi, PiePinnedMessage } from '../../../../shared/pie-chat-contract'

type PinnedBannerProps = {
  channelId: string
  api: PieChatRendererApi
}

function authorLabel(authorId: string): string {
  return authorId.slice(0, 8)
}

export function PinnedBanner({ channelId, api }: PinnedBannerProps): React.JSX.Element | null {
  const [pin, setPin] = useState<PiePinnedMessage | null>(null)

  useEffect(() => {
    let cancelled = false
    setPin(null)
    void api
      .listPins(channelId)
      .then((pins) => {
        if (!cancelled) {
          // Pins arrive most-recent-first (message-pin-store#listPins); show the newest.
          setPin(pins[0] ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPin(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [api, channelId])

  if (!pin) {
    return null
  }

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground">
      <span aria-hidden>📌</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{pin.message.body}</span>
      <span className="shrink-0">pinned by {authorLabel(pin.pinnedBy)}</span>
    </div>
  )
}
