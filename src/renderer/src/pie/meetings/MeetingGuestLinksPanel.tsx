import { Copy, Link2, Link2Off, Plus } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import type { MeetingGuestLink } from './meeting-types'

type CreatedGuestLink = { link: MeetingGuestLink; rawToken: string }

function identityLabel(mode: MeetingGuestLink['identityMode']): string {
  return mode === 'account_required'
    ? translate('auto.pie.meetings.MeetingGuestLinksPanel.pieAccount', 'Pie account')
    : translate('auto.pie.meetings.MeetingGuestLinksPanel.limitedGuest', 'Limited guest')
}

function visibilityLabel(visibility: MeetingGuestLink['visibility']): string {
  return visibility === 'meeting_only'
    ? translate('auto.pie.meetings.MeetingGuestLinksPanel.meetingOnly', 'Meeting only')
    : translate('auto.pie.meetings.MeetingGuestLinksPanel.meetingRecap', 'Meeting + recap')
}

export function MeetingGuestLinksPanel({
  meetingId,
  canManage
}: {
  meetingId: string
  canManage: boolean
}): React.JSX.Element {
  const links = usePieResource<{ items: MeetingGuestLink[] }>(`/meetings/${meetingId}/guest-links`)
  const [identityMode, setIdentityMode] = useState<'account_required' | 'limited_guest'>(
    'account_required'
  )
  const [visibility, setVisibility] = useState<'meeting_only' | 'meeting_and_recap'>('meeting_only')
  const [expiresInHours, setExpiresInHours] = useState('24')
  const [rawToken, setRawToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      links.refetch()
    } catch (caught) {
      setError(
        caught instanceof PieApiError
          ? `${caught.code ?? caught.status}: ${caught.message}`
          : String(caught)
      )
    } finally {
      setBusy(false)
    }
  }

  const create = (): void => {
    void run(async () => {
      const created = await apiPost<CreatedGuestLink>(`/meetings/${meetingId}/guest-links`, {
        identityMode,
        visibility,
        expiresInHours: Number(expiresInHours)
      })
      // Why: only the hash is persisted, so the raw bearer can only be copied from this one-time view.
      setRawToken(created.rawToken)
    })
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Link2 className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.pie.meetings.MeetingGuestLinksPanel.title', 'Guest links')}
        </h3>
        <Badge variant="secondary" className="ml-auto">
          {links.data?.items.length ?? 0}
        </Badge>
      </div>
      <div className="space-y-2 p-3">
        {(links.data?.items ?? []).map((link) => {
          const inactive =
            Boolean(link.revokedAt) || new Date(link.expiresAt).getTime() <= Date.now()
          return (
            <div
              key={link.id}
              className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 text-xs text-foreground">
                {identityLabel(link.identityMode)} · {visibilityLabel(link.visibility)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {new Date(link.expiresAt).toLocaleString()}
              </span>
              <Badge variant="outline">
                {inactive
                  ? translate('auto.pie.meetings.MeetingGuestLinksPanel.inactive', 'Inactive')
                  : translate('auto.pie.meetings.MeetingGuestLinksPanel.active', 'Active')}
              </Badge>
              {canManage && !inactive && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={translate(
                    'auto.pie.meetings.MeetingGuestLinksPanel.revoke',
                    'Revoke guest link'
                  )}
                  onClick={() =>
                    void run(() =>
                      apiPost(
                        `/meeting-guest-links/${link.id}:revoke`,
                        undefined,
                        resourceEtag('meeting-guest-link', link.version)
                      )
                    )
                  }
                >
                  <Link2Off />
                </Button>
              )}
            </div>
          )
        })}
        {canManage && (
          <div className="grid grid-cols-[1fr_1fr_5rem_auto] gap-2">
            <Select
              value={identityMode}
              onValueChange={(value) => setIdentityMode(value as typeof identityMode)}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="account_required">
                  {identityLabel('account_required')}
                </SelectItem>
                <SelectItem value="limited_guest">{identityLabel('limited_guest')}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={visibility}
              onValueChange={(value) => setVisibility(value as typeof visibility)}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="meeting_only">{visibilityLabel('meeting_only')}</SelectItem>
                <SelectItem value="meeting_and_recap">
                  {visibilityLabel('meeting_and_recap')}
                </SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={1}
              max={720}
              value={expiresInHours}
              onChange={(event) => setExpiresInHours(event.target.value)}
              aria-label={translate(
                'auto.pie.meetings.MeetingGuestLinksPanel.expiry',
                'Expiry in hours'
              )}
            />
            <Button size="sm" variant="outline" disabled={busy} onClick={create}>
              <Plus />
              {translate('auto.pie.meetings.MeetingGuestLinksPanel.create', 'Create')}
            </Button>
          </div>
        )}
        {rawToken && (
          <div className="flex gap-2 rounded-md border border-border p-2">
            <Input readOnly value={rawToken} className="font-mono text-xs" />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(rawToken)}
            >
              <Copy />
              {translate('auto.pie.meetings.MeetingGuestLinksPanel.copy', 'Copy once')}
            </Button>
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </section>
  )
}
