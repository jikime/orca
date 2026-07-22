import { CalendarPlus, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { usePieResource } from '../control-plane/use-pie-resource'
import type { MeetingResource, MeetingScopeKind } from '../meetings/meeting-types'
import { queuePieMeetingNavigation } from '../meetings/pie-meeting-navigation'

type ContextScope = Exclude<MeetingScopeKind, 'none'>

export function PieResourceMeetingLinks({
  scopeKind,
  resourceId,
  title
}: {
  scopeKind: ContextScope
  resourceId: string
  title: string
}): React.JSX.Element {
  const query = usePieResource<{ items: MeetingResource[] }>(
    `/meetings?scopeKind=${scopeKind}&scopeId=${encodeURIComponent(resourceId)}`
  )
  const meetings = query.data?.items ?? []

  return (
    <section className="border-t border-border px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Video className="size-3.5 text-muted-foreground" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate('auto.pie.workspace.PieResourceMeetingLinks.title', 'Meetings')}
        </h3>
        <span className="ml-auto text-[11px] text-muted-foreground">{meetings.length}</span>
      </div>
      {query.loading ? (
        <p className="text-xs text-muted-foreground">
          {translate('auto.pie.workspace.PieResourceMeetingLinks.loading', 'Loading…')}
        </p>
      ) : meetings.length > 0 ? (
        <div className="mb-2 space-y-1">
          {meetings.slice(0, 5).map((meeting) => (
            <button
              key={meeting.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
              onClick={() => queuePieMeetingNavigation({ meetingId: meeting.id })}
            >
              <span className="min-w-0 flex-1 truncate text-foreground">{meeting.title}</span>
              <span className="text-muted-foreground">{meeting.status}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="mb-2 text-xs text-muted-foreground">
          {translate(
            'auto.pie.workspace.PieResourceMeetingLinks.empty',
            'No meetings are linked yet.'
          )}
        </p>
      )}
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() =>
          queuePieMeetingNavigation({
            create: {
              scopeKind,
              scopeId: resourceId,
              title: translate(
                'auto.pie.workspace.PieResourceMeetingLinks.defaultTitle',
                '{{value0}} meeting',
                { value0: title }
              )
            }
          })
        }
      >
        <CalendarPlus />
        {translate('auto.pie.workspace.PieResourceMeetingLinks.schedule', 'Schedule meeting')}
      </Button>
    </section>
  )
}
