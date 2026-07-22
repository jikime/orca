import { useEffect, useState } from 'react'
import type {
  PieChatMember,
  PieChatRendererApi,
  PiePinnedMessage
} from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'
import { chatMemberDisplayName } from './chat-member-display-name'

type PinnedBannerProps = {
  channelId: string
  api: PieChatRendererApi
  members: PieChatMember[]
  refreshKey?: string
}

export function PinnedBanner({
  channelId,
  api,
  members,
  refreshKey
}: PinnedBannerProps): React.JSX.Element | null {
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
  }, [api, channelId, refreshKey])

  if (!pin) {
    return null
  }

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground">
      <span aria-hidden>📌</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{pin.message.body}</span>
      <span className="shrink-0">
        {translate('auto.pie.chat.PinnedBanner.8ce9b55bfd', 'pinned by')}{' '}
        {chatMemberDisplayName(pin.pinnedBy, members)}
      </span>
    </div>
  )
}
