import { useEffect, useState } from 'react'
import type {
  PieChannel,
  PieChatRendererApi,
  PieMessage
} from '../../../../shared/pie-chat-contract'
import { PinsPanel } from './PinsPanel'
import { MessageSearch } from './MessageSearch'

type ChatHeaderProps = {
  channel: PieChannel | undefined
  api: PieChatRendererApi
  onSearchSelect: (message: PieMessage) => void
}

function isMuted(channel: PieChannel): boolean {
  // The channel resource carries the viewer's mute state via a passthrough field
  // when present; default to unmuted so the toggle still works optimistically.
  return (channel as { muted?: boolean }).muted === true
}

export function ChatHeader({ channel, api, onSearchSelect }: ChatHeaderProps): React.JSX.Element {
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    setMuted(channel ? isMuted(channel) : false)
  }, [channel])

  const toggleMute = async (): Promise<void> => {
    if (!channel) {
      return
    }
    const next = !muted
    setMuted(next) // optimistic; mute endpoints are idempotent 204s
    try {
      await (next ? api.muteChannel(channel.id) : api.unmuteChannel(channel.id))
    } catch {
      setMuted(!next)
    }
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
      <h2 className="truncate text-sm font-medium text-foreground">
        {channel ? `${channel.kind === 'dm' ? '@' : '#'} ${channel.name}` : 'Chat'}
        {muted && <span className="ml-2 text-xs text-muted-foreground">muted</span>}
      </h2>
      {channel && (
        <div className="flex items-center gap-1">
          <MessageSearch api={api} onSelect={onSearchSelect} />
          <PinsPanel channelId={channel.id} api={api} onJumpToMessage={() => undefined} />
          <button
            type="button"
            onClick={() => void toggleMute()}
            aria-pressed={muted}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {muted ? '🔔 Unmute' : '🔕 Mute'}
          </button>
        </div>
      )}
    </header>
  )
}
