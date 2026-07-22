import { useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, Pencil, Play, X } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { apiPatch, apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { queuePieWorkItemNavigation } from '../workspace/pie-work-item-navigation'
import { MeetingActionWorkItemDialog } from './MeetingActionWorkItemDialog'
import type { MeetingActionItem } from './meeting-types'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

function localDateTime(value: string | null): string {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export function MeetingActionItemRow({
  actionItem,
  canManage,
  canReview,
  canCreateWork,
  focused = false,
  onChanged,
  onOpenEvidence
}: {
  actionItem: MeetingActionItem
  canManage: boolean
  canReview: boolean
  canCreateWork: boolean
  focused?: boolean
  onChanged: () => void
  onOpenEvidence: (segmentId: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [converting, setConverting] = useState(false)
  const [task, setTask] = useState(actionItem.task)
  const [dueAt, setDueAt] = useState(localDateTime(actionItem.dueAt))
  const [priority, setPriority] = useState(actionItem.priority)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rowRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (focused) {
      rowRef.current?.scrollIntoView?.({ block: 'center' })
    }
  }, [focused])

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
        `/meeting-action-items/${actionItem.id}`,
        {
          task: task.trim(),
          assigneeUserId: actionItem.assigneeUserId,
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          priority,
          evidenceSegmentId: actionItem.evidenceSegmentId
        },
        resourceEtag('meeting-action-item', actionItem.version)
      )
    )

  const review = (decision: 'approve' | 'reject'): Promise<void> =>
    mutate(() =>
      apiPost(
        `/meeting-action-items/${actionItem.id}:review`,
        { decision },
        resourceEtag('meeting-action-item', actionItem.version)
      )
    )

  const dueLabel = actionItem.dueAt
    ? new Date(actionItem.dueAt).toLocaleString()
    : actionItem.dueText

  return (
    <article
      ref={rowRef}
      data-focused={focused ? 'true' : undefined}
      className={cn(
        'space-y-2 rounded-md border border-border bg-muted/20 p-2.5',
        focused && 'border-ring ring-2 ring-ring/30'
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={actionItem.reviewStatus === 'approved' ? 'secondary' : 'outline'}>
          {actionItem.reviewStatus}
        </Badge>
        {actionItem.priority !== 'none' && <Badge variant="outline">{actionItem.priority}</Badge>}
        {actionItem.workItemId && (
          <Badge variant="secondary">
            {translate('auto.pie.meetings.outcomes.workItem', 'Work item')}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {actionItem.evidenceSegmentId && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onOpenEvidence(actionItem.evidenceSegmentId!)}
            >
              <Play />
              {translate('auto.pie.meetings.outcomes.evidence', 'Evidence')}
            </Button>
          )}
          {canManage && !editing && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Edit action item"
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
            value={task}
            maxLength={20_000}
            onChange={(event) => setTask(event.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="datetime-local"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
            />
            <Select
              value={priority}
              onValueChange={(value) => setPriority(value as typeof priority)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['none', 'urgent', 'high', 'medium', 'low'].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-1">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              {translate('auto.pie.meetings.outcomes.cancel', 'Cancel')}
            </Button>
            <Button size="xs" onClick={() => void save()} disabled={busy || !task.trim()}>
              {translate('auto.pie.meetings.outcomes.save', 'Save')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-xs text-foreground">{actionItem.task}</p>
          {(actionItem.assigneeLabel || dueLabel) && (
            <p className="text-[11px] text-muted-foreground">
              {[actionItem.assigneeLabel, dueLabel].filter(Boolean).join(' · ')}
            </p>
          )}
        </>
      )}
      {!editing && (
        <div className="flex flex-wrap gap-1">
          {canReview && (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void review('approve')}
              >
                <Check />
                {translate('auto.pie.meetings.outcomes.approve', 'Approve')}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void review('reject')}
              >
                <X />
                {translate('auto.pie.meetings.outcomes.reject', 'Reject')}
              </Button>
            </>
          )}
          {canCreateWork && actionItem.reviewStatus === 'approved' && !actionItem.workItemId && (
            <Button size="xs" variant="outline" onClick={() => setConverting(true)}>
              {translate('auto.pie.meetings.outcomes.toWork', 'Create work item')}
            </Button>
          )}
          {actionItem.workItemId && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => queuePieWorkItemNavigation({ workItemId: actionItem.workItemId! })}
            >
              <ExternalLink />
              {translate('auto.pie.meetings.outcomes.openWork', 'Open work item')}
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <MeetingActionWorkItemDialog
        actionItem={actionItem}
        open={converting}
        onOpenChange={setConverting}
        onChanged={onChanged}
      />
    </article>
  )
}
