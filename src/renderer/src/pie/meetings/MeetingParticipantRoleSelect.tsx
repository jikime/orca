import { useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { apiPatch, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { meetingRoleLabel } from './meeting-participant-labels'
import type { MeetingParticipant } from './meeting-types'

type AssignableRole = Exclude<MeetingParticipant['role'], 'host'>

export function MeetingParticipantRoleSelect({
  participant,
  onChanged
}: {
  participant: MeetingParticipant
  onChanged: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const changeRole = async (role: AssignableRole): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await apiPatch(
        `/meeting-participants/${participant.id}`,
        { role },
        resourceEtag('meeting-participant', participant.version)
      )
      onChanged()
    } catch (caught) {
      const message =
        caught instanceof PieApiError
          ? `${caught.code ?? caught.status}: ${caught.message}`
          : caught instanceof Error
            ? caught.message
            : String(caught)
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="min-w-0">
      <Select
        value={participant.role}
        disabled={busy}
        onValueChange={(value) => void changeRole(value as AssignableRole)}
      >
        <SelectTrigger
          className="h-7 w-28 text-xs"
          aria-label={translate('auto.pie.meetings.role.choose', 'Choose participant role')}
        >
          <SelectValue>{meetingRoleLabel(participant.role)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(['co_host', 'presenter', 'participant'] as const).map((role) => (
            <SelectItem key={role} value={role}>
              {meetingRoleLabel(role)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <span className="block text-destructive">{error}</span>}
    </span>
  )
}
