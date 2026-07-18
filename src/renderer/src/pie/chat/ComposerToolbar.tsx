import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { translate } from '@/i18n/i18n'

type ComposerToolbarProps = {
  canSend: boolean
  sending: boolean
  onSend: () => void
  // Left-aligned controls (attach, mention, …). Omitted where a composer has
  // none — e.g. the thread reply composer — never filled with a decorative button.
  children?: ReactNode
  // The "Aa" formatting toggle; omitted where a composer has no formatting row.
  formattingVisible?: boolean
  onToggleFormatting?: () => void
}

// Bottom row of the Slack-style composer: functional controls on the left,
// Send on the right. Shared so ChannelComposer and MessageComposer stay visual siblings.
export function ComposerToolbar({
  canSend,
  sending,
  onSend,
  children,
  formattingVisible,
  onToggleFormatting
}: ComposerToolbarProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-2 pb-2">
      <div className="flex items-center gap-1">
        {onToggleFormatting && (
          <Toggle
            size="sm"
            pressed={formattingVisible}
            onPressedChange={onToggleFormatting}
            aria-label="Toggle formatting"
            className="text-muted-foreground"
          >
            {translate('auto.pie.chat.ComposerToolbar.1fda93a8c8', 'Aa')}
          </Toggle>
        )}
        {children}
      </div>
      <Button type="button" size="sm" onClick={onSend} disabled={!canSend}>
        {sending
          ? translate('auto.pie.chat.ComposerToolbar.d591551131', 'Sending…')
          : translate('auto.pie.chat.ComposerToolbar.dbf6c0f4ed', 'Send')}
      </Button>
    </div>
  )
}
