import { CalendarSync, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { apiPost, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import type { MeetingCalendarLink, MeetingCalendarProvider, MeetingResource } from './meeting-types'

const LABELS: Record<MeetingCalendarProvider, string> = {
  google_workspace: 'Google Calendar',
  microsoft_365: 'Microsoft 365'
}

export function MeetingCalendarPanel({
  meeting,
  canManage
}: {
  meeting: MeetingResource
  canManage: boolean
}): React.JSX.Element {
  const providers = usePieResource<{ items: MeetingCalendarProvider[] }>(
    '/meeting-calendar-providers'
  )
  const links = usePieResource<{ items: MeetingCalendarLink[] }>(
    `/meetings/${meeting.id}/calendar-exports`
  )
  const [busy, setBusy] = useState<MeetingCalendarProvider | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sync = async (provider: MeetingCalendarProvider): Promise<void> => {
    setBusy(provider)
    setError(null)
    try {
      await apiPost(`/meetings/${meeting.id}/calendar-exports`, { provider })
      links.refetch()
    } catch (caught) {
      setError(
        caught instanceof PieApiError
          ? `${caught.code ?? caught.status}: ${caught.message}`
          : String(caught)
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <CalendarSync className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.pie.meetings.MeetingCalendarPanel.title', 'Calendar')}
        </h3>
      </div>
      <div className="space-y-2 p-3">
        {(links.data?.items ?? []).map((link) => (
          <div key={link.id} className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {LABELS[link.provider]}
            </span>
            <Badge variant="outline">{link.syncStatus}</Badge>
            {link.webUrl && (
              <a
                href={link.webUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground"
                aria-label={translate(
                  'auto.pie.meetings.MeetingCalendarPanel.open',
                  'Open calendar event'
                )}
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        ))}
        {canManage && meeting.scheduledStart && (
          <div className="flex flex-wrap gap-2">
            {(providers.data?.items ?? []).map((provider) => (
              <Button
                key={provider}
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void sync(provider)}
              >
                <CalendarSync />
                {busy === provider
                  ? translate('auto.pie.meetings.MeetingCalendarPanel.syncing', 'Syncing…')
                  : LABELS[provider]}
              </Button>
            ))}
          </div>
        )}
        {!providers.loading && (providers.data?.items.length ?? 0) === 0 && (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.pie.meetings.MeetingCalendarPanel.notConfigured',
              'Connect Google Workspace or Microsoft 365 in the server environment to export this meeting.'
            )}
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </section>
  )
}
