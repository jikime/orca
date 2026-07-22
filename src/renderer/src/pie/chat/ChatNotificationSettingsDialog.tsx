import { useState } from 'react'
import { BellRing } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  PieChannel,
  PieChannelNotificationLevel,
  PieChatRendererApi
} from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'

type ChatNotificationSettingsDialogProps = {
  channel: PieChannel
  api: PieChatRendererApi
}

function formatMinute(value: number): string {
  const hours = Math.floor(value / 60)
  const minutes = value % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function parseMinute(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':')
  return Number(hours) * 60 + Number(minutes)
}

export function ChatNotificationSettingsDialog({
  channel,
  api
}: ChatNotificationSettingsDialogProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [level, setLevel] = useState<PieChannelNotificationLevel>('mentions')
  const [desktopEnabled, setDesktopEnabled] = useState(true)
  const [dndEnabled, setDndEnabled] = useState(false)
  const [dndStart, setDndStart] = useState('22:00')
  const [dndEnd, setDndEnd] = useState('08:00')
  const [timezone, setTimezone] = useState('UTC')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const preferences = await api.getNotificationPreferences()
      setDesktopEnabled(preferences.desktopEnabled)
      setDndEnabled(preferences.dndEnabled)
      setDndStart(formatMinute(preferences.dndStartMinute))
      setDndEnd(formatMinute(preferences.dndEndMinute))
      setTimezone(preferences.timezone)
      setLevel(
        preferences.channelLevels.find((item) => item.channelId === channel.id)?.level ?? 'mentions'
      )
    } catch {
      setError(
        translate(
          'auto.pie.chat.ChatNotificationSettingsDialog.loadfailed',
          'Could not load notification settings.'
        )
      )
    } finally {
      setLoading(false)
    }
  }

  const changeOpen = (next: boolean): void => {
    setOpen(next)
    if (next) {
      void load()
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await api.updateNotificationPreferences({
        desktopEnabled,
        dndEnabled,
        dndStartMinute: parseMinute(dndStart),
        dndEndMinute: parseMinute(dndEnd),
        timezone
      })
      await api.setChannelNotificationLevel(channel.id, level)
      setOpen(false)
    } catch {
      setError(
        translate(
          'auto.pie.chat.ChatNotificationSettingsDialog.savefailed',
          'Could not save notification settings.'
        )
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={translate(
                'auto.pie.chat.ChatNotificationSettingsDialog.trigger',
                'Notification settings'
              )}
            >
              <BellRing />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {translate(
            'auto.pie.chat.ChatNotificationSettingsDialog.trigger',
            'Notification settings'
          )}
        </TooltipContent>
      </Tooltip>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.pie.chat.ChatNotificationSettingsDialog.title',
              'Notification settings'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.pie.chat.ChatNotificationSettingsDialog.description',
              'Choose what #{{value0}} sends and when desktop alerts are allowed.',
              { value0: channel.name }
            )}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="py-4 text-sm text-muted-foreground">
            {translate('auto.pie.chat.ChatNotificationSettingsDialog.loading', 'Loading…')}
          </p>
        ) : (
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="chat-notification-level">
                {translate('auto.pie.chat.ChatNotificationSettingsDialog.level', 'Notify me about')}
              </Label>
              <Select
                value={level}
                onValueChange={(value) => setLevel(value as PieChannelNotificationLevel)}
              >
                <SelectTrigger id="chat-notification-level" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {translate(
                      'auto.pie.chat.ChatNotificationSettingsDialog.all',
                      'All new messages'
                    )}
                  </SelectItem>
                  <SelectItem value="mentions">
                    {translate(
                      'auto.pie.chat.ChatNotificationSettingsDialog.mentions',
                      'Mentions only'
                    )}
                  </SelectItem>
                  <SelectItem value="none">
                    {translate('auto.pie.chat.ChatNotificationSettingsDialog.none', 'Nothing')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-start gap-3">
              <Checkbox
                checked={desktopEnabled}
                onCheckedChange={(checked) => setDesktopEnabled(checked === true)}
              />
              <span>
                <span className="block text-sm font-medium text-foreground">
                  {translate(
                    'auto.pie.chat.ChatNotificationSettingsDialog.desktop',
                    'Desktop alerts'
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {translate(
                    'auto.pie.chat.ChatNotificationSettingsDialog.desktophelp',
                    'Also requires notifications to be enabled in Orca settings.'
                  )}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <Checkbox
                checked={dndEnabled}
                onCheckedChange={(checked) => setDndEnabled(checked === true)}
              />
              <span className="text-sm font-medium text-foreground">
                {translate('auto.pie.chat.ChatNotificationSettingsDialog.dnd', 'Do not disturb')}
              </span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="chat-dnd-start">
                  {translate('auto.pie.chat.ChatNotificationSettingsDialog.start', 'Start')}
                </Label>
                <Input
                  id="chat-dnd-start"
                  type="time"
                  value={dndStart}
                  disabled={!dndEnabled}
                  onChange={(event) => setDndStart(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="chat-dnd-end">
                  {translate('auto.pie.chat.ChatNotificationSettingsDialog.end', 'End')}
                </Label>
                <Input
                  id="chat-dnd-end"
                  type="time"
                  value={dndEnd}
                  disabled={!dndEnabled}
                  onChange={(event) => setDndEnd(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-dnd-timezone">
                {translate('auto.pie.chat.ChatNotificationSettingsDialog.timezone', 'Time zone')}
              </Label>
              <Input
                id="chat-dnd-timezone"
                value={timezone}
                disabled={!dndEnabled}
                placeholder={translate(
                  'auto.pie.chat.ChatNotificationSettingsDialog.timezoneplaceholder',
                  'Asia/Seoul'
                )}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </div>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" disabled={loading || saving} onClick={() => void save()}>
            {saving
              ? translate('auto.pie.chat.ChatNotificationSettingsDialog.saving', 'Saving…')
              : translate('auto.pie.chat.ChatNotificationSettingsDialog.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
