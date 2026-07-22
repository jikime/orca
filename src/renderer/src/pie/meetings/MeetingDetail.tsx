import { useEffect, useMemo, useState } from 'react'
import { CircleStop, MessageSquareText, Play, Radio, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import { PieStatusBadge } from '../workspace/PieStatusBadge'
import { LiveMeetingRoom } from './LiveMeetingRoom'
import { MeetingMinutesPanel } from './MeetingMinutesPanel'
import { MeetingParticipantsPanel } from './MeetingParticipantsPanel'
import { MeetingRecordingPanel } from './MeetingRecordingPanel'
import { MeetingAgendaPanel } from './MeetingAgendaPanel'
import { MeetingOutcomesPanel } from './MeetingOutcomesPanel'
import { MeetingRecapPanel } from './MeetingRecapPanel'
import { MeetingGovernancePanel } from './MeetingGovernancePanel'
import { MeetingCalendarPanel } from './MeetingCalendarPanel'
import { MeetingGuestLinksPanel } from './MeetingGuestLinksPanel'
import type { MeetingParticipant, MeetingResource, MeetingStatus } from './meeting-types'
import { openMeetingConversation } from './meeting-chat'
import { meetingRecurrenceLabel, meetingScopeLabel } from './meeting-schedule-labels'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingDetail({
  meeting,
  onUpdated,
  permissions,
  currentUserId,
  focusedActionItemId
}: {
  meeting: MeetingResource
  onUpdated: (meeting: MeetingResource) => void
  permissions: string[]
  currentUserId: string | null
  focusedActionItemId?: string | null
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState(
    focusedActionItemId ? 'room' : meeting.status === 'ended' ? 'recap' : 'room'
  )
  const participants = usePieResource<{ items: MeetingParticipant[] }>(
    `/meetings/${meeting.id}/participants`
  )
  const refetchParticipants = participants.refetch

  useEffect(() => {
    if (focusedActionItemId) {
      setActiveTab('room')
    }
  }, [focusedActionItemId])

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

  const openChat = async (): Promise<void> => {
    setChatBusy(true)
    setError(null)
    try {
      await openMeetingConversation(meeting)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setChatBusy(false)
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
                  value0: meetingScopeLabel(meeting.scopeKind),
                  value1: meeting.scopeId ?? ''
                })}
            {meeting.scheduledStart &&
              ` · ${new Date(meeting.scheduledStart).toLocaleString([], { timeZone: meeting.timeZone })} · ${meeting.timeZone}${meeting.recurrence === 'none' ? '' : ` · ${meetingRecurrenceLabel(meeting.recurrence)}`}`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void openChat()} disabled={chatBusy}>
            <MessageSquareText />
            {translate('auto.pie.meetings.MeetingDetail.openchat', 'Open meeting chat')}
          </Button>
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
      <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="mx-4 mt-1">
          <TabsTrigger value="room">
            <Radio />
            {translate('auto.pie.meetings.MeetingDetail.room', 'Meeting room')}
          </TabsTrigger>
          <TabsTrigger value="recap">
            <ScrollText />
            {translate('auto.pie.meetings.MeetingDetail.recap', 'Recap')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="room" className="min-h-0 overflow-y-auto scrollbar-sleek">
          <div className="grid min-h-full grid-cols-1 gap-3 p-3 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
            <div className="flex min-h-[24rem] min-w-0 flex-col rounded-lg border border-border bg-card p-3">
              {meeting.status === 'live' ? (
                <LiveMeetingRoom
                  meetingId={meeting.id}
                  onParticipantsChanged={refetchParticipants}
                />
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
                canManage={permissions.includes('meeting.manage')}
                currentUserId={currentUserId}
                hostUserId={meeting.hostUserId}
                onChanged={refetchParticipants}
              />
              <MeetingCalendarPanel
                meeting={meeting}
                canManage={permissions.includes('meeting.manage')}
              />
              <MeetingGuestLinksPanel
                meetingId={meeting.id}
                canManage={permissions.includes('meeting.manage')}
              />
              <MeetingRecordingPanel
                meeting={meeting}
                live={meeting.status === 'live'}
                joinedParticipantIds={joined.map((participant) => participant.id)}
                canManageTranscript={permissions.includes('meeting.manage')}
              />
              <MeetingGovernancePanel
                meeting={meeting}
                canManage={permissions.includes('meeting.manage')}
              />
              <MeetingAgendaPanel meetingId={meeting.id} />
              <MeetingOutcomesPanel
                meetingId={meeting.id}
                permissions={permissions}
                focusedActionItemId={focusedActionItemId}
              />
              <MeetingMinutesPanel meeting={meeting} />
            </div>
          </div>
        </TabsContent>
        <TabsContent value="recap" className="min-h-0">
          <MeetingRecapPanel
            meetingId={meeting.id}
            canManageTranscript={permissions.includes('meeting.manage')}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
