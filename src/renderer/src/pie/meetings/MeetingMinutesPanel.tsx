import { useEffect, useMemo, useState } from 'react'
import { Check, FileText, MessageSquareText, Save, Send, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { apiPatch, apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import type { MeetingMinutes, MeetingResource } from './meeting-types'
import {
  openPublishedMeetingMessage,
  publishMeetingMessage,
  type PublishedMeetingMessage
} from './meeting-chat'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingMinutesPanel({ meeting }: { meeting: MeetingResource }): React.JSX.Element {
  const meetingId = meeting.id
  const query = usePieResource<{ items: MeetingMinutes[] }>(`/meetings/${meetingId}/minutes`)
  useEffect(() => {
    // AI minutes arrive asynchronously after recording processing, so keep this panel current.
    const interval = window.setInterval(query.refetch, 5_000)
    return () => window.clearInterval(interval)
  }, [query.refetch])
  const newest = useMemo(
    () => (query.data?.items ?? []).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    [query.data]
  )
  // Why: background polling must not remount the editor and discard a user's draft.
  const editorKey = newest?.id ?? 'new'
  return (
    <MeetingMinutesEditor
      key={`${editorKey}:${newest?.version ?? 0}`}
      meetingId={meetingId}
      meeting={meeting}
      initialMinutes={newest ?? null}
      loading={query.loading}
      initialError={query.error}
      onChanged={query.refetch}
    />
  )
}

function MeetingMinutesEditor({
  meeting,
  meetingId,
  initialMinutes,
  loading,
  initialError,
  onChanged
}: {
  meeting: MeetingResource
  meetingId: string
  initialMinutes: MeetingMinutes | null
  loading: boolean
  initialError: string | null
  onChanged: () => void
}): React.JSX.Element {
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(initialMinutes)
  const [draft, setDraft] = useState(initialMinutes?.summary ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  const [published, setPublished] = useState<PublishedMeetingMessage | null>(null)
  const revisions = usePieResource<{ items: { revision: number }[] }>(
    minutes ? `/meeting-minutes/${minutes.id}/revisions` : null
  )

  const run = async (mutation: () => Promise<MeetingMinutes>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const updated = await mutation()
      setMinutes(updated)
      setDraft(updated.summary)
      onChanged()
      revisions.refetch()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const create = (): void => {
    const summary = draft.trim()
    if (!summary) {
      return
    }
    void run(() =>
      apiPost<MeetingMinutes>(`/meetings/${meetingId}/minutes`, {
        summary,
        sourceType: 'manual'
      })
    )
  }

  const save = (): void => {
    if (!minutes || !draft.trim()) {
      return
    }
    void run(() =>
      apiPatch<MeetingMinutes>(
        `/meeting-minutes/${minutes.id}`,
        { summary: draft.trim() },
        resourceEtag('meeting-minutes', minutes.version)
      )
    )
  }

  const finalize = (): void => {
    if (!minutes) {
      return
    }
    void run(() =>
      apiPost<MeetingMinutes>(
        `/meeting-minutes/${minutes.id}:finalize`,
        undefined,
        resourceEtag('meeting-minutes', minutes.version)
      )
    )
  }

  const review = (decision: 'approve' | 'reject'): void => {
    if (!minutes) {
      return
    }
    void run(() =>
      apiPost<MeetingMinutes>(
        `/meeting-minutes/${minutes.id}:review`,
        { decision },
        resourceEtag('meeting-minutes', minutes.version)
      )
    )
  }

  const publish = async (): Promise<void> => {
    if (!minutes || minutes.status !== 'finalized') {
      return
    }
    setBusy(true)
    setError(null)
    try {
      setPublished(
        await publishMeetingMessage(
          meeting,
          `minutes:${minutes.id}`,
          `## ${translate(
            'auto.pie.meetings.MeetingMinutesPanel.publishedtitle',
            'Meeting minutes: {{value0}}',
            { value0: meeting.title }
          )}\n\n${minutes.summary}`
        )
      )
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const finalized = minutes?.status === 'finalized'
  const dirty = Boolean(minutes && draft.trim() !== minutes.summary)

  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <FileText className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.pie.meetings.MeetingMinutesPanel.title', 'Meeting minutes')}
        </h3>
        {minutes && (
          <Badge variant="outline" className="ml-auto">
            {minutes.sourceType === 'ai'
              ? translate('auto.pie.meetings.MeetingMinutesPanel.ai', 'AI draft')
              : translate('auto.pie.meetings.MeetingMinutesPanel.manual', 'Manual')}
          </Badge>
        )}
        {minutes && (
          <Badge variant="secondary">
            {finalized
              ? translate('auto.pie.meetings.MeetingMinutesPanel.finalized', 'Finalized')
              : translate('auto.pie.meetings.MeetingMinutesPanel.draft', 'Draft')}
          </Badge>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {loading ? (
          <p className="text-xs text-muted-foreground">
            {translate('auto.pie.meetings.MeetingMinutesPanel.loading', 'Loading minutes…')}
          </p>
        ) : (
          <Textarea
            className="min-h-48 flex-1 resize-none"
            value={draft}
            disabled={finalized}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={translate(
              'auto.pie.meetings.MeetingMinutesPanel.placeholder',
              'Capture the discussion, decisions, owners, and next actions…'
            )}
          />
        )}
        {minutes && (
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>
              {translate(
                'auto.pie.meetings.MeetingMinutesPanel.revisions',
                '{{value0}} saved revision(s)',
                { value0: revisions.data?.items.length ?? 1 }
              )}
            </span>
            {minutes.sourceType === 'ai' && <span>{minutes.reviewStatus}</span>}
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!finalized && (
          <div className="flex flex-wrap gap-2">
            {!minutes ? (
              <Button size="sm" onClick={create} disabled={busy || !draft.trim()}>
                <Save />
                {translate('auto.pie.meetings.MeetingMinutesPanel.create', 'Create draft')}
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={save} disabled={busy || !dirty || !draft.trim()}>
                  <Save />
                  {translate('auto.pie.meetings.MeetingMinutesPanel.save', 'Save')}
                </Button>
                {minutes.sourceType === 'ai' && minutes.reviewStatus === 'unreviewed' && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => review('approve')}
                      disabled={busy || dirty}
                    >
                      <Check />
                      {translate('auto.pie.meetings.MeetingMinutesPanel.approve', 'Approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => review('reject')}
                      disabled={busy || dirty}
                    >
                      <X />
                      {translate('auto.pie.meetings.MeetingMinutesPanel.reject', 'Reject')}
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={finalize}
                  disabled={
                    busy ||
                    dirty ||
                    (minutes.sourceType === 'ai' && minutes.reviewStatus !== 'approved')
                  }
                >
                  <Check />
                  {translate('auto.pie.meetings.MeetingMinutesPanel.finalize', 'Finalize')}
                </Button>
              </>
            )}
          </div>
        )}
        {finalized && (
          <div className="flex flex-wrap gap-2">
            {!published ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void publish()}>
                <Send />
                {translate('auto.pie.meetings.MeetingMinutesPanel.publish', 'Publish to chat')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openPublishedMeetingMessage(published)}
              >
                <MessageSquareText />
                {translate('auto.pie.meetings.MeetingMinutesPanel.openpost', 'Open chat post')}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
