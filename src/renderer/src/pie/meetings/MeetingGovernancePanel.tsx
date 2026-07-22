import { useEffect, useState } from 'react'
import { Download, Scale, Settings2, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import {
  apiGet,
  apiPatch,
  apiPost,
  PieApiError,
  resourceEtag
} from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import type {
  MeetingGovernance,
  MeetingGovernanceAuditEntry,
  MeetingResource
} from './meeting-types'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function MeetingGovernancePanel({
  meeting,
  canManage
}: {
  meeting: MeetingResource
  canManage: boolean
}): React.JSX.Element {
  const governance = usePieResource<MeetingGovernance>(`/meetings/${meeting.id}/governance`)
  const audit = usePieResource<{ items: MeetingGovernanceAuditEntry[] }>(
    canManage ? `/meetings/${meeting.id}/governance-audit` : null
  )
  const [purpose, setPurpose] = useState('')
  const [retentionDays, setRetentionDays] = useState('90')
  const [legalHold, setLegalHold] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteReason, setDeleteReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!governance.data) {
      return
    }
    setPurpose(governance.data.purpose)
    setRetentionDays(governance.data.retentionDays?.toString() ?? '')
    setLegalHold(governance.data.legalHold)
  }, [governance.data])

  const mutate = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      governance.refetch()
      audit.refetch()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!governance.data) {
      return
    }
    const days = retentionDays.trim() ? Number(retentionDays) : null
    await mutate(() =>
      apiPatch(
        `/meetings/${meeting.id}/governance`,
        { purpose: purpose.trim(), retentionDays: days, legalHold },
        resourceEtag('meeting-governance', governance.data!.version)
      )
    )
  }

  const exportData = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const exported = await apiGet(`/meetings/${meeting.id}/governance-export`)
      downloadJson(`meeting-${meeting.id}-export.json`, exported)
      audit.refetch()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const requestDeletion = async (): Promise<void> => {
    if (!governance.data) {
      return
    }
    await mutate(() =>
      apiPost(
        `/meetings/${meeting.id}/deletion-requests`,
        { reason: deleteReason.trim(), confirmation },
        resourceEtag('meeting-governance', governance.data!.version)
      )
    )
    setDeleteOpen(false)
    setDeleteReason('')
    setConfirmation('')
  }

  const state = governance.data

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Scale className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.pie.meetings.governance.title', 'Capture governance')}
        </h3>
        {state && (
          <Badge variant="outline" className="ml-auto">
            {state.deletionStatus}
          </Badge>
        )}
      </div>
      <div className="space-y-3 p-3">
        {state && (
          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <span>
              {translate('auto.pie.meetings.governance.policy', 'Policy v{{value0}}', {
                value0: state.policyVersion
              })}
            </span>
            <span className="text-right">
              {state.retentionUntil
                ? new Date(state.retentionUntil).toLocaleDateString()
                : translate('auto.pie.meetings.governance.indefinite', 'No automatic deletion')}
            </span>
          </div>
        )}
        {canManage && state && state.deletionStatus !== 'completed' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`meeting-purpose-${meeting.id}`}>
                {translate('auto.pie.meetings.governance.purpose', 'Capture purpose')}
              </Label>
              <Textarea
                id={`meeting-purpose-${meeting.id}`}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`meeting-retention-${meeting.id}`}>
                {translate('auto.pie.meetings.governance.retention', 'Retention days')}
              </Label>
              <Input
                id={`meeting-retention-${meeting.id}`}
                type="number"
                min={1}
                max={3650}
                value={retentionDays}
                onChange={(event) => setRetentionDays(event.target.value)}
                placeholder={translate('auto.pie.meetings.governance.keep', 'Keep indefinitely')}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-foreground">
              <Checkbox
                checked={legalHold}
                onCheckedChange={(value) => setLegalHold(value === true)}
              />
              {translate('auto.pie.meetings.governance.legalHold', 'Legal hold blocks deletion')}
            </label>
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.pie.meetings.governance.reconsent',
                'Changing this policy requires participants to review capture permissions again.'
              )}
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {canManage && state?.deletionStatus !== 'completed' && (
            <Button size="sm" disabled={busy || !purpose.trim()} onClick={() => void save()}>
              <Settings2 />
              {translate('auto.pie.meetings.governance.save', 'Save policy')}
            </Button>
          )}
          {canManage && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportData()}>
              <Download />
              {translate('auto.pie.meetings.governance.export', 'Export JSON')}
            </Button>
          )}
          {canManage &&
            state &&
            meeting.status !== 'live' &&
            state.deletionStatus !== 'completed' && (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || state.legalHold}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 />
                {translate('auto.pie.meetings.governance.delete', 'Delete captured data')}
              </Button>
            )}
        </div>
        {state?.deletionLastError && (
          <p className="text-xs text-destructive">{state.deletionLastError}</p>
        )}
        {(error || governance.error || audit.error) && (
          <p className="text-xs text-destructive">{error ?? governance.error ?? audit.error}</p>
        )}
        {canManage && (audit.data?.items.length ?? 0) > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">
              {translate('auto.pie.meetings.governance.audit', 'Governance audit')}
            </summary>
            <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto scrollbar-sleek">
              {audit.data!.items.map((entry) => (
                <li key={entry.id}>
                  {new Date(entry.occurredAt).toLocaleString()} · {entry.action}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.pie.meetings.governance.deleteTitle',
                'Delete captured meeting data'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.pie.meetings.governance.deleteBody',
                'Recordings, transcripts, AI minutes and derived outcomes will be permanently removed. Audit metadata remains.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={deleteReason}
              onChange={(event) => setDeleteReason(event.target.value)}
              placeholder={translate('auto.pie.meetings.governance.reason', 'Deletion reason')}
            />
            <Input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={meeting.title}
            />
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.pie.meetings.governance.confirm',
                'Type the meeting title exactly: {{value0}}',
                { value0: meeting.title }
              )}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={busy || deleteReason.trim().length < 3 || confirmation !== meeting.title}
              onClick={() => void requestDeletion()}
            >
              {translate('auto.pie.meetings.governance.queueDelete', 'Queue deletion')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
