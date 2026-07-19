import { useEffect, useMemo, useState } from 'react'
import { CircleStop, Play, Radio } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import { PieStatusBadge } from '../workspace/PieStatusBadge'
import { LiveMeetingRoom } from './LiveMeetingRoom'
import { MeetingMinutesPanel } from './MeetingMinutesPanel'
import { MeetingParticipantsPanel } from './MeetingParticipantsPanel'
import { MeetingRecordingPanel } from './MeetingRecordingPanel'
import type { MeetingParticipant, MeetingResource, MeetingStatus } from './meeting-types'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingDetail({
  meeting,
  onUpdated
}: {
  meeting: MeetingResource
  onUpdated: (meeting: MeetingResource) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const participants = usePieResource<{ items: MeetingParticipant[] }>(
    `/meetings/${meeting.id}/participants`
  )
  const refetchParticipants = participants.refetch

  useEffect(() => {
    if (meeting.status !== 'live') {
      return
    }
    // Signed LiveKit presence is asynchronous, so refresh while a room can change membership.
    const interval = window.setInterval(refetchParticipants, 5_000)
    return () => window.clearInterval(interval)
  }, [meeting.status, refetchParticipants])

  const joined = useMemo(
    () => (participants.data?.items ?? []).filter((item) => item.joinedAt && !item.leftAt),
    [participants.data]
  )
  const recordingReady = joined.length > 0 && joined.every((item) => item.consentRecording)

  const transition = async (toStatus: MeetingStatus): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const updated = await apiPost<MeetingResource>(
        `/meetings/${meeting.id}:transition`,
        { toStatus },
        resourceEtag('meeting', meeting.version)
      )
      onUpdated(updated)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-foreground">{meeting.title}</h2>
            <PieStatusBadge value={meeting.status} />
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {meeting.scopeKind === 'none'
              ? translate('auto.pie.meetings.MeetingDetail.noScope', 'Organization meeting')
              : translate('auto.pie.meetings.MeetingDetail.scope', '{{value0}} · {{value1}}', {
                  value0: meeting.scopeKind,
                  value1: meeting.scopeId ?? ''
                })}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {meeting.status === 'live' && (
            <Badge variant={recordingReady ? 'secondary' : 'outline'}>
              {recordingReady
                ? translate('auto.pie.meetings.MeetingDetail.recordingReady', 'Recording ready')
                : translate(
                    'auto.pie.meetings.MeetingDetail.recordingBlocked',
                    'Waiting for recording consent'
                  )}
            </Badge>
          )}
          {meeting.status === 'scheduled' && (
            <Button size="sm" onClick={() => void transition('live')} disabled={busy}>
              <Play />
              {translate('auto.pie.meetings.MeetingDetail.start', 'Start meeting')}
            </Button>
          )}
          {meeting.status === 'live' && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void transition('ended')}
              disabled={busy}
            >
              <CircleStop />
              {translate('auto.pie.meetings.MeetingDetail.end', 'End meeting')}
            </Button>
          )}
        </div>
      </header>
      {error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] gap-3 overflow-y-auto p-3 scrollbar-sleek">
        <div className="flex min-h-[24rem] min-w-0 flex-col rounded-lg border border-border bg-card p-3">
          {meeting.status === 'live' ? (
            <LiveMeetingRoom meetingId={meeting.id} onParticipantsChanged={refetchParticipants} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <div className="rounded-full bg-muted p-3 text-muted-foreground">
                <Radio className="size-5" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {meeting.status === 'scheduled'
                    ? translate(
                        'auto.pie.meetings.MeetingDetail.scheduledTitle',
                        'This meeting has not started'
                      )
                    : translate(
                        'auto.pie.meetings.MeetingDetail.endedTitle',
                        'This meeting has ended'
                      )}
                </p>
                <p className="mt-1 max-w-md text-xs text-muted-foreground">
                  {meeting.status === 'scheduled'
                    ? translate(
                        'auto.pie.meetings.MeetingDetail.scheduledBody',
                        'Invite participants and prepare the minutes before going live.'
                      )
                    : translate(
                        'auto.pie.meetings.MeetingDetail.endedBody',
                        'The media room is closed. Minutes and participant history remain available.'
                      )}
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <MeetingParticipantsPanel
            meetingId={meeting.id}
            participants={participants.data?.items ?? []}
            loading={participants.loading}
            onChanged={refetchParticipants}
          />
          <MeetingRecordingPanel
            meetingId={meeting.id}
            live={meeting.status === 'live'}
            recordingReady={recordingReady}
          />
          <MeetingMinutesPanel meetingId={meeting.id} />
        </div>
      </div>
    </div>
  )
}
