import { useCallback, useEffect, useState } from 'react'
import { Download, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import type {
  PieChannel,
  PieChannelAuditEntry,
  PieChatMember,
  PieChatRendererApi
} from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'
import { chatMemberDisplayName } from './chat-member-display-name'

type ChannelGovernancePanelProps = {
  channel: PieChannel
  currentUserId: string
  members: PieChatMember[]
  api: PieChatRendererApi
  onUpdated: (channel: PieChannel) => void
}

function safeExportFilename(channelName: string): string {
  const safeName = channelName.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'channel'
  return `${safeName}-messages.json`
}

function auditActor(
  entry: PieChannelAuditEntry,
  members: PieChatMember[],
  currentUserId: string
): string {
  if (!entry.actorId) {
    return translate('auto.pie.chat.ChannelGovernancePanel.system', 'System')
  }
  return chatMemberDisplayName(entry.actorId, members, currentUserId)
}

export function ChannelGovernancePanel({
  channel,
  currentUserId,
  members,
  api,
  onUpdated
}: ChannelGovernancePanelProps): React.JSX.Element {
  const [retentionDays, setRetentionDays] = useState(channel.retentionDays?.toString() ?? '')
  const [audit, setAudit] = useState<PieChannelAuditEntry[]>([])
  const [loadingAudit, setLoadingAudit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRetentionDays(channel.retentionDays?.toString() ?? '')
  }, [channel.retentionDays])

  const loadAudit = useCallback(async (): Promise<void> => {
    setLoadingAudit(true)
    setError(null)
    try {
      setAudit(await api.listChannelAudit(channel.id))
    } catch {
      setError(
        translate('auto.pie.chat.ChannelGovernancePanel.auditfailed', 'Could not load audit log.')
      )
    } finally {
      setLoadingAudit(false)
    }
  }, [api, channel.id])

  useEffect(() => {
    void loadAudit()
  }, [loadAudit])

  const saveRetention = async (): Promise<void> => {
    const parsed = retentionDays === '' ? null : Number(retentionDays)
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650)) {
      setError(
        translate(
          'auto.pie.chat.ChannelGovernancePanel.retentioninvalid',
          'Retention must be between 1 and 3650 days.'
        )
      )
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const updated = await api.updateChannel(
        channel.id,
        { retentionDays: parsed },
        channel.version
      )
      onUpdated(updated)
      setStatus(
        parsed === null
          ? translate('auto.pie.chat.ChannelGovernancePanel.disabled', 'Retention disabled.')
          : translate('auto.pie.chat.ChannelGovernancePanel.saved', 'Retention policy saved.')
      )
    } catch {
      setError(
        translate(
          'auto.pie.chat.ChannelGovernancePanel.savefailed',
          'Could not save the retention policy.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const applyRetention = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const redactedCount = await api.applyChannelRetention(channel.id)
      setStatus(
        translate(
          'auto.pie.chat.ChannelGovernancePanel.applied',
          '{{value0}} expired messages were removed.',
          { value0: redactedCount }
        )
      )
      await loadAudit()
    } catch {
      setError(
        translate(
          'auto.pie.chat.ChannelGovernancePanel.applyfailed',
          'Could not apply the retention policy.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const downloadExport = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const data = await api.exportChannel(channel.id)
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      )
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = safeExportFilename(channel.name)
      anchor.click()
      // Keep the URL alive through Chromium's download dispatch.
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch {
      setError(
        translate('auto.pie.chat.ChannelGovernancePanel.exportfailed', 'Could not export messages.')
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-md border border-border p-3">
        <div>
          <Label htmlFor="channel-retention-days">
            {translate('auto.pie.chat.ChannelGovernancePanel.retention', 'Message retention')}
          </Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'auto.pie.chat.ChannelGovernancePanel.retentionhelp',
              'Leave blank to retain messages indefinitely. Applying a policy permanently redacts expired message bodies.'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id="channel-retention-days"
            type="number"
            min={1}
            max={3650}
            value={retentionDays}
            placeholder={translate('auto.pie.chat.ChannelGovernancePanel.forever', 'Forever')}
            onChange={(event) => setRetentionDays(event.target.value)}
          />
          <Button type="button" size="sm" disabled={busy} onClick={() => void saveRetention()}>
            {translate('auto.pie.chat.ChannelGovernancePanel.save', 'Save')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !channel.retentionDays}
            onClick={() => void applyRetention()}
          >
            <ShieldCheck />
            {translate('auto.pie.chat.ChannelGovernancePanel.apply', 'Apply now')}
          </Button>
        </div>
      </section>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">
          {translate('auto.pie.chat.ChannelGovernancePanel.audit', 'Recent audit activity')}
        </h3>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={downloadExport}
          >
            <Download />
            {translate('auto.pie.chat.ChannelGovernancePanel.export', 'Export JSON')}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={loadingAudit}
            aria-label={translate(
              'auto.pie.chat.ChannelGovernancePanel.refresh',
              'Refresh audit log'
            )}
            onClick={() => void loadAudit()}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      <ScrollArea className="h-44 rounded-md border border-border">
        <div className="space-y-1 p-2">
          {loadingAudit ? (
            <p className="p-2 text-xs text-muted-foreground">
              {translate('auto.pie.chat.ChannelGovernancePanel.loading', 'Loading…')}
            </p>
          ) : audit.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {translate(
                'auto.pie.chat.ChannelGovernancePanel.emptyaudit',
                'No audit activity yet.'
              )}
            </p>
          ) : (
            audit.map((entry) => (
              <div key={entry.id} className="rounded-md px-2 py-1.5 hover:bg-accent">
                <p className="text-xs text-foreground">
                  {auditActor(entry, members, currentUserId)} · {entry.action}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(entry.occurredAt).toLocaleString()}
                  {entry.reason ? ` · ${entry.reason}` : ''}
                </p>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
      {status && (
        <p className="text-xs text-muted-foreground" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
