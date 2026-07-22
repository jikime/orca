import { Check, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import type { MeetingParticipant } from './meeting-types'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingAdmissionControls({
  participant,
  onChanged
}: {
  participant: MeetingParticipant
  onChanged: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const decide = async (action: 'admit' | 'deny'): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await apiPost(
        `/meeting-participant-controls/${participant.id}:${action}`,
        undefined,
        resourceEtag('meeting-participant', participant.version)
      )
      onChanged()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="flex items-center gap-1">
      <Button
        size="icon-xs"
        variant="outline"
        disabled={busy}
        aria-label={translate('auto.pie.meetings.waitingRoom.admit', 'Admit participant')}
        onClick={() => void decide('admit')}
      >
        <Check />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        disabled={busy}
        aria-label={translate('auto.pie.meetings.waitingRoom.deny', 'Deny participant')}
        onClick={() => void decide('deny')}
      >
        <X />
      </Button>
      {error && <span className="text-destructive">{error}</span>}
    </span>
  )
}
