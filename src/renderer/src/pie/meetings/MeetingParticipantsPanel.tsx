import { useState } from 'react'
import { Check, UserPlus, Users, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { apiPost, PieApiError } from '../control-plane/pie-api-client'
import type { MeetingParticipant } from './meeting-types'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingParticipantsPanel({
  meetingId,
  participants,
  loading,
  onChanged
}: {
  meetingId: string
  participants: MeetingParticipant[]
  loading: boolean
  onChanged: () => void
}): React.JSX.Element {
  const [inviteeId, setInviteeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const invite = async (): Promise<void> => {
    const userId = inviteeId.trim()
    if (!userId) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await apiPost(`/meetings/${meetingId}/participants`, { userId, role: 'participant' })
      setInviteeId('')
      onChanged()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Users className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.pie.meetings.MeetingParticipantsPanel.title', 'Participants')}
        </h3>
        <Badge variant="secondary" className="ml-auto">
          {participants.length}
        </Badge>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex gap-2">
          <Input
            value={inviteeId}
            onChange={(event) => setInviteeId(event.target.value)}
            placeholder={translate(
              'auto.pie.meetings.MeetingParticipantsPanel.userId',
              'Organization user ID'
            )}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void invite()
              }
            }}
          />
          <Button size="sm" variant="outline" onClick={() => void invite()} disabled={busy}>
            <UserPlus />
            {translate('auto.pie.meetings.MeetingParticipantsPanel.invite', 'Invite')}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {loading ? (
          <p className="text-xs text-muted-foreground">
            {translate('auto.pie.meetings.MeetingParticipantsPanel.loading', 'Loading…')}
          </p>
        ) : participants.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.pie.meetings.MeetingParticipantsPanel.empty',
              'The host will be added when they join.'
            )}
          </p>
        ) : (
          <ul className="max-h-48 space-y-1.5 overflow-y-auto pr-1 scrollbar-sleek">
            {participants.map((participant) => {
              const connected = Boolean(participant.joinedAt && !participant.leftAt)
              return (
                <li
                  key={participant.id}
                  className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                    {participant.userId}
                  </span>
                  <span className="text-muted-foreground">{participant.role}</span>
                  <span
                    className="flex items-center gap-1 text-muted-foreground"
                    title={translate(
                      'auto.pie.meetings.MeetingParticipantsPanel.recordingConsent',
                      'Recording consent'
                    )}
                  >
                    {participant.consentRecording ? (
                      <Check className="size-3.5" />
                    ) : (
                      <X className="size-3.5" />
                    )}
                  </span>
                  <span
                    className={
                      connected
                        ? 'size-1.5 rounded-full bg-foreground'
                        : 'size-1.5 rounded-full bg-border'
                    }
                    title={
                      connected
                        ? translate(
                            'auto.pie.meetings.MeetingParticipantsPanel.connected',
                            'Connected'
                          )
                        : translate(
                            'auto.pie.meetings.MeetingParticipantsPanel.notConnected',
                            'Not connected'
                          )
                    }
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
