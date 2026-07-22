import { useState } from 'react'
import { MicOff, UserX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { apiPost, PieApiError } from '../control-plane/pie-api-client'
import type { MeetingParticipant } from './meeting-types'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingParticipantControls({
  participant,
  onChanged
}: {
  participant: MeetingParticipant
  onChanged: () => void
}): React.JSX.Element {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const control = async (action: 'mute' | 'remove'): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await apiPost(`/meeting-participant-controls/${participant.id}:${action}`)
      setConfirmingRemove(false)
      onChanged()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={translate('auto.pie.meetings.participants.mute', 'Mute participant')}
        disabled={busy}
        onClick={() => void control('mute')}
      >
        <MicOff />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        aria-label={translate('auto.pie.meetings.participants.remove', 'Remove participant')}
        disabled={busy}
        onClick={() => setConfirmingRemove(true)}
      >
        <UserX />
      </Button>
      <Dialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {translate('auto.pie.meetings.participants.removeTitle', 'Remove participant?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.pie.meetings.participants.removeBody',
                'They will be disconnected and cannot rejoin until invited again.'
              )}
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingRemove(false)} disabled={busy}>
              {translate('auto.pie.meetings.participants.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void control('remove')} disabled={busy}>
              {translate('auto.pie.meetings.participants.removeConfirm', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error && !confirmingRemove && <span className="text-[11px] text-destructive">{error}</span>}
    </>
  )
}
