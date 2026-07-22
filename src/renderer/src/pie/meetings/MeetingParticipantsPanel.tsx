import { useState } from 'react'
import { Check, Users, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { apiPost, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import type { MeetingParticipant } from './meeting-types'
import { MeetingAdmissionControls } from './MeetingAdmissionControls'
import { MeetingParticipantControls } from './MeetingParticipantControls'
import { MeetingParticipantRoleSelect } from './MeetingParticipantRoleSelect'
import { meetingAccessStatusLabel, meetingRoleLabel } from './meeting-participant-labels'
import { MeetingMemberPicker, type MeetingMember } from './MeetingMemberPicker'

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
  canManage,
  currentUserId,
  hostUserId,
  onChanged
}: {
  meetingId: string
  participants: MeetingParticipant[]
  loading: boolean
  canManage: boolean
  currentUserId: string | null
  hostUserId: string
  onChanged: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actor = participants.find((participant) => participant.userId === currentUserId)
  const canControl =
    currentUserId === hostUserId || (actor?.accessStatus === 'admitted' && actor.role === 'co_host')
  const membersQuery = usePieResource<{ items: MeetingMember[] }>('/memberships?limit=100')
  const members = membersQuery.data?.items ?? []
  const names = new Map(members.map((member) => [member.userId, member.displayName]))
  const participantIds = new Set(participants.map((participant) => participant.userId))

  const invite = async (member: MeetingMember): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await apiPost(`/meetings/${meetingId}/participants`, {
        userId: member.userId,
        role: 'participant'
      })
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
        {canManage && (
          <MeetingMemberPicker
            members={members}
            excludedUserIds={participantIds}
            disabled={busy || membersQuery.loading}
            onSelect={(member) => void invite(member)}
          />
        )}
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
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">
                      {names.get(participant.userId) ?? participant.userId.slice(0, 8)}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {participant.userId}
                    </span>
                  </span>
                  <Badge variant="outline">
                    {meetingAccessStatusLabel(participant.accessStatus)}
                  </Badge>
                  {canControl && participant.role !== 'host' ? (
                    <MeetingParticipantRoleSelect participant={participant} onChanged={onChanged} />
                  ) : (
                    <span className="text-muted-foreground">
                      {meetingRoleLabel(participant.role)}
                    </span>
                  )}
                  {canControl && participant.accessStatus === 'waiting' && (
                    <MeetingAdmissionControls participant={participant} onChanged={onChanged} />
                  )}
                  {canControl && connected && participant.role !== 'host' && (
                    <MeetingParticipantControls participant={participant} onChanged={onChanged} />
                  )}
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
