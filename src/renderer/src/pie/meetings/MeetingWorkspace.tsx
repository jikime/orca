import { useEffect, useState } from 'react'
import { Calendar, Plus, Video } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { apiGet, apiPost, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import { PieStatusBadge } from '../workspace/PieStatusBadge'
import { MeetingDetail } from './MeetingDetail'
import type { MeetingResource } from './meeting-types'
import type { MeetingScopeKind } from './meeting-types'
import { subscribePieMeetingNavigation, takePieMeetingNavigation } from './pie-meeting-navigation'
import { MeetingReminderScheduler } from './MeetingReminderScheduler'
import { MeetingScheduleFields, type MeetingScheduleDraft } from './MeetingScheduleFields'
import { zonedDateTimeToIso } from './meeting-schedule-time'
import { meetingRecurrenceLabel } from './meeting-schedule-labels'

const EMPTY_MEETINGS: MeetingResource[] = []
const EMPTY_SCHEDULE: MeetingScheduleDraft = {
  start: '',
  end: '',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  recurrence: 'none'
}

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingWorkspace(): React.JSX.Element {
  const list = usePieResource<{ items: MeetingResource[] }>('/meetings')
  const [selected, setSelected] = useState<MeetingResource | null>(null)
  const [focusedActionItemId, setFocusedActionItemId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [scopeKind, setScopeKind] = useState<MeetingScopeKind>('none')
  const [scopeId, setScopeId] = useState('')
  const [schedule, setSchedule] = useState<MeetingScheduleDraft>(EMPTY_SCHEDULE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<string[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const items = list.data?.items ?? EMPTY_MEETINGS

  useEffect(() => {
    let cancelled = false
    const applySession = (session: Awaited<ReturnType<typeof window.api.pie.session.getState>>) => {
      if (!cancelled) {
        setPermissions(session.status === 'signed_in' ? session.permissions : [])
        setCurrentUserId(session.status === 'signed_in' ? session.userId : null)
      }
    }
    void window.api.pie.session.getState().then(applySession)
    // Keep edit controls aligned with token refresh and account switches.
    const unsubscribe = window.api.pie.session.onChanged((event) => applySession(event.session))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const openPending = (): void => {
      const target = takePieMeetingNavigation()
      if (!target) {
        return
      }
      if ('create' in target) {
        setCreating(true)
        setSelected(null)
        setFocusedActionItemId(null)
        setScopeKind(target.create.scopeKind)
        setScopeId(target.create.scopeId)
        setTitle(target.create.title ?? '')
        return
      }
      setFocusedActionItemId(target.actionItemId ?? null)
      const loaded = items.find((item) => item.id === target.meetingId)
      if (loaded) {
        setSelected(loaded)
        return
      }
      void apiGet<MeetingResource>(`/meetings/${target.meetingId}`)
        .then(setSelected)
        .catch((caught) => setError(errorText(caught)))
    }
    openPending()
    return subscribePieMeetingNavigation(openPending)
  }, [items])

  const create = async (): Promise<void> => {
    if (!title.trim() || (scopeKind !== 'none' && !scopeId.trim())) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (
        schedule.start &&
        schedule.end &&
        new Date(schedule.end).getTime() <= new Date(schedule.start).getTime()
      ) {
        throw new Error(
          translate(
            'auto.pie.meetings.MeetingWorkspace.invalidSchedule',
            'The meeting end must be after its start.'
          )
        )
      }
      if (Boolean(schedule.start) !== Boolean(schedule.end)) {
        throw new Error(
          translate(
            'auto.pie.meetings.MeetingWorkspace.completeSchedule',
            'Enter both the meeting start and end.'
          )
        )
      }
      const scheduledStart = schedule.start
        ? zonedDateTimeToIso(schedule.start, schedule.timeZone)
        : null
      const scheduledEnd = schedule.end ? zonedDateTimeToIso(schedule.end, schedule.timeZone) : null
      if (schedule.start && (!scheduledStart || !scheduledEnd)) {
        throw new Error(
          translate(
            'auto.pie.meetings.MeetingWorkspace.invalidWallClock',
            'The selected local time does not exist in this time zone.'
          )
        )
      }
      const created = await apiPost<MeetingResource>('/meetings', {
        title: title.trim(),
        scopeKind,
        ...(scopeKind === 'none' ? {} : { scopeId: scopeId.trim() }),
        ...(scheduledStart ? { scheduledStart } : {}),
        ...(scheduledEnd ? { scheduledEnd } : {}),
        timeZone: schedule.timeZone,
        recurrence: schedule.recurrence
      })
      setSelected(created)
      setCreating(false)
      setTitle('')
      setScopeKind('none')
      setScopeId('')
      setSchedule(EMPTY_SCHEDULE)
      list.refetch()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const handleUpdated = (meeting: MeetingResource): void => {
    setSelected(meeting)
    list.refetch()
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[18rem_minmax(0,1fr)] bg-background">
      <MeetingReminderScheduler meetings={items} />
      <aside className="flex min-h-0 flex-col border-r border-border bg-sidebar">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Video className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            {translate('auto.pie.meetings.MeetingWorkspace.title', 'Meetings')}
          </h2>
          {!list.loading && (
            <Badge variant="secondary" className="ml-auto">
              {items.length}
            </Badge>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={translate('auto.pie.meetings.MeetingWorkspace.new', 'New meeting')}
            title={translate('auto.pie.meetings.MeetingWorkspace.new', 'New meeting')}
            onClick={() => {
              setFocusedActionItemId(null)
              setCreating((value) => !value)
            }}
          >
            <Plus />
          </Button>
        </header>
        {creating && (
          <div className="space-y-2 border-b border-border bg-muted/30 p-3">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={translate(
                'auto.pie.meetings.MeetingWorkspace.meetingTitle',
                'Meeting title'
              )}
              autoFocus
            />
            <Select
              value={scopeKind}
              onValueChange={(value) => setScopeKind(value as typeof scopeKind)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {translate('auto.pie.meetings.MeetingWorkspace.scopeNone', 'Organization')}
                </SelectItem>
                <SelectItem value="project">
                  {translate('auto.pie.meetings.MeetingWorkspace.scopeProject', 'Project')}
                </SelectItem>
                <SelectItem value="ticket">
                  {translate('auto.pie.meetings.MeetingWorkspace.scopeTicket', 'Ticket')}
                </SelectItem>
                <SelectItem value="remote_session">
                  {translate(
                    'auto.pie.meetings.MeetingWorkspace.scopeRemoteSession',
                    'Remote session'
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
            {scopeKind !== 'none' && (
              <Input
                value={scopeId}
                onChange={(event) => setScopeId(event.target.value)}
                placeholder={translate('auto.pie.meetings.MeetingWorkspace.scopeId', 'Scope ID')}
              />
            )}
            <MeetingScheduleFields value={schedule} onChange={setSchedule} />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void create()}
                disabled={
                  busy ||
                  !title.trim() ||
                  (scopeKind !== 'none' && !scopeId.trim()) ||
                  Boolean(schedule.start) !== Boolean(schedule.end)
                }
              >
                {translate('auto.pie.meetings.MeetingWorkspace.create', 'Create')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                {translate('auto.pie.meetings.MeetingWorkspace.cancel', 'Cancel')}
              </Button>
            </div>
          </div>
        )}
        {(error || list.error) && (
          <p className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error ?? list.error}
          </p>
        )}
        <ScrollArea className="min-h-0 flex-1" viewportClassName="p-2">
          {list.loading ? (
            <p className="p-2 text-xs text-muted-foreground">
              {translate('auto.pie.meetings.MeetingWorkspace.loading', 'Loading meetings…')}
            </p>
          ) : items.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {translate(
                'auto.pie.meetings.MeetingWorkspace.empty',
                'Create a meeting to start a call and capture minutes.'
              )}
            </p>
          ) : (
            <div className="space-y-1">
              {items.map((meeting) => (
                <button
                  key={meeting.id}
                  type="button"
                  className={cn(
                    'flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent',
                    selected?.id === meeting.id && 'bg-sidebar-accent'
                  )}
                  onClick={() => {
                    setFocusedActionItemId(null)
                    setSelected(meeting)
                  }}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                      {meeting.title}
                    </span>
                    <PieStatusBadge value={meeting.status} />
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Calendar className="size-3" />
                    {new Date(meeting.scheduledStart ?? meeting.createdAt).toLocaleString([], {
                      timeZone: meeting.timeZone
                    })}
                    {meeting.recurrence !== 'none' &&
                      ` · ${meetingRecurrenceLabel(meeting.recurrence)}`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </aside>
      <main className="min-h-0">
        {selected ? (
          <MeetingDetail
            key={selected.id}
            meeting={selected}
            onUpdated={handleUpdated}
            permissions={permissions}
            currentUserId={currentUserId}
            focusedActionItemId={focusedActionItemId}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div>
              <Video className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium text-foreground">
                {translate('auto.pie.meetings.MeetingWorkspace.selectTitle', 'Select a meeting')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {translate(
                  'auto.pie.meetings.MeetingWorkspace.selectBody',
                  'Open a meeting to manage the call, participants, and minutes.'
                )}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
