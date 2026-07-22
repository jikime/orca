import { useState } from 'react'
import { Check, Pencil, Play, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { apiPatch, apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import type { MeetingDecision } from './meeting-types'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingDecisionRow({
  decision,
  canManage,
  canReview,
  onChanged,
  onOpenEvidence
}: {
  decision: MeetingDecision
  canManage: boolean
  canReview: boolean
  onChanged: () => void
  onOpenEvidence: (segmentId: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [statement, setStatement] = useState(decision.statement)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mutate = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await operation()
      setEditing(false)
      onChanged()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    mutate(() =>
      apiPatch(
        `/meeting-decisions/${decision.id}`,
        {
          statement: statement.trim(),
          ownerUserId: decision.ownerUserId,
          evidenceSegmentId: decision.evidenceSegmentId
        },
        resourceEtag('meeting-decision', decision.version)
      )
    )

  const review = (reviewDecision: 'approve' | 'reject'): Promise<void> =>
    mutate(() =>
      apiPost(
        `/meeting-decisions/${decision.id}:review`,
        { decision: reviewDecision },
        resourceEtag('meeting-decision', decision.version)
      )
    )

  return (
    <article className="space-y-2 rounded-md border border-border bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">
          {decision.createdBy === 'ai'
            ? translate('auto.pie.meetings.outcomes.ai', 'AI')
            : translate('auto.pie.meetings.outcomes.manual', 'Manual')}
        </Badge>
        <Badge variant={decision.reviewStatus === 'approved' ? 'secondary' : 'outline'}>
          {decision.reviewStatus}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          {decision.evidenceSegmentId && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onOpenEvidence(decision.evidenceSegmentId!)}
            >
              <Play />
              {translate('auto.pie.meetings.outcomes.evidence', 'Evidence')}
            </Button>
          )}
          {canManage && !editing && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Edit decision"
              onClick={() => setEditing(true)}
            >
              <Pencil />
            </Button>
          )}
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea
            value={statement}
            maxLength={20_000}
            onChange={(event) => setStatement(event.target.value)}
          />
          <div className="flex justify-end gap-1">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              {translate('auto.pie.meetings.outcomes.cancel', 'Cancel')}
            </Button>
            <Button size="xs" onClick={() => void save()} disabled={busy || !statement.trim()}>
              {translate('auto.pie.meetings.outcomes.save', 'Save')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-xs text-foreground">{decision.statement}</p>
      )}
      {canReview && !editing && (
        <div className="flex gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void review('approve')}
          >
            <Check />
            {translate('auto.pie.meetings.outcomes.approve', 'Approve')}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void review('reject')}>
            <X />
            {translate('auto.pie.meetings.outcomes.reject', 'Reject')}
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </article>
  )
}
