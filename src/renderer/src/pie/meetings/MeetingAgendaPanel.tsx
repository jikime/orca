import { ListChecks, MessageSquareText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { queuePieChatNavigation } from '../chat/pie-chat-navigation'
import { usePieResource } from '../control-plane/use-pie-resource'
import type { MeetingAgendaItem } from './meeting-types'

export function MeetingAgendaPanel({ meetingId }: { meetingId: string }): React.JSX.Element {
  const query = usePieResource<{ items: MeetingAgendaItem[] }>(
    `/meetings/${meetingId}/agenda-items`
  )
  const items = query.data?.items ?? []

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <ListChecks className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.pie.meetings.MeetingAgendaPanel.title', 'Agenda')}
        </h3>
        <Badge variant="secondary" className="ml-auto">
          {items.length}
        </Badge>
      </div>
      <div className="space-y-2 p-3">
        {query.loading ? (
          <p className="text-xs text-muted-foreground">
            {translate('auto.pie.meetings.MeetingAgendaPanel.loading', 'Loading agenda…')}
          </p>
        ) : items.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.pie.meetings.MeetingAgendaPanel.empty',
              'Add a meeting-channel message to prepare the agenda.'
            )}
          </p>
        ) : (
          <ol className="space-y-2">
            {items.map((item, index) => (
              <li key={item.id} className="flex gap-2 rounded-md border border-border p-2.5">
                <span className="text-xs font-medium text-muted-foreground">{index + 1}</span>
                <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-foreground">
                  {item.body}
                </p>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={translate(
                    'auto.pie.meetings.MeetingAgendaPanel.opensource',
                    'Open source message'
                  )}
                  title={translate(
                    'auto.pie.meetings.MeetingAgendaPanel.opensource',
                    'Open source message'
                  )}
                  onClick={() =>
                    queuePieChatNavigation({
                      channelId: item.sourceChannelId,
                      messageId: item.sourceMessageId
                    })
                  }
                >
                  <MessageSquareText />
                </Button>
              </li>
            ))}
          </ol>
        )}
        {query.error && <p className="text-xs text-destructive">{query.error}</p>}
      </div>
    </section>
  )
}
