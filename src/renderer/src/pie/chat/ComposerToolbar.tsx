import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'

type ComposerToolbarProps = {
  canSend: boolean
  sending: boolean
  onSend: () => void
  // Left-aligned controls (attach, mention, …). Omitted where a composer has
  // none — e.g. the thread reply composer — never filled with a decorative button.
  children?: ReactNode
}

// Bottom row of the Slack-style composer: functional controls on the left,
// Send on the right. Shared so ChannelComposer and MessageComposer stay visual siblings.
export function ComposerToolbar({
  canSend,
  sending,
  onSend,
  children
}: ComposerToolbarProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-2 pb-2">
      <div className="flex items-center gap-1">{children}</div>
      <Button type="button" size="sm" onClick={onSend} disabled={!canSend}>
        {sending ? 'Sending…' : 'Send'}
      </Button>
    </div>
  )
}
