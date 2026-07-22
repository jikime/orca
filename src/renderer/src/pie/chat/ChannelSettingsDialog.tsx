import { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, Settings, UserMinus } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  PieChannel,
  PieChannelMember,
  PieChatMember,
  PieChatRendererApi
} from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'
import { ChannelGovernancePanel } from './ChannelGovernancePanel'

type ChannelSettingsDialogProps = {
  channel: PieChannel
  currentUserId: string
  members: PieChatMember[]
  api: PieChatRendererApi
  onUpdated: (channel: PieChannel) => void
}

function memberName(userId: string, members: PieChatMember[], currentUserId: string): string {
  if (userId === currentUserId) {
    return translate('auto.pie.chat.ChannelSettingsDialog.you', 'You')
  }
  return members.find((member) => member.userId === userId)?.displayName ?? userId.slice(0, 8)
}

export function ChannelSettingsDialog({
  channel,
  currentUserId,
  members,
  api,
  onUpdated
}: ChannelSettingsDialogProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(channel.name)
  const [topic, setTopic] = useState(channel.topic)
  const [description, setDescription] = useState(channel.description)
  const [channelMembers, setChannelMembers] = useState<PieChannelMember[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = useMemo(
    () =>
      name.trim() !== channel.name ||
      topic !== channel.topic ||
      description !== channel.description,
    [channel.description, channel.name, channel.topic, description, name, topic]
  )

  useEffect(() => {
    setName(channel.name)
    setTopic(channel.topic)
    setDescription(channel.description)
  }, [channel])

  const loadRoster = async (): Promise<void> => {
    setLoadingMembers(true)
    try {
      setChannelMembers(await api.listChannelMembers(channel.id))
    } catch {
      setError(
        translate(
          'auto.pie.chat.ChannelSettingsDialog.membersfailed',
          'Could not load channel members.'
        )
      )
    } finally {
      setLoadingMembers(false)
    }
  }

  const changeOpen = (next: boolean): void => {
    setOpen(next)
    setError(null)
    if (next) {
      void loadRoster()
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const updated = await api.updateChannel(
        channel.id,
        { name: name.trim(), topic, description },
        channel.version
      )
      onUpdated(updated)
      setOpen(false)
    } catch {
      setError(
        translate('auto.pie.chat.ChannelSettingsDialog.savefailed', 'Could not save the channel.')
      )
    } finally {
      setBusy(false)
    }
  }

  const setArchived = async (archived: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const updated = await api.updateChannel(channel.id, { archived }, channel.version)
      onUpdated(updated)
      setOpen(false)
    } catch {
      setError(
        translate(
          'auto.pie.chat.ChannelSettingsDialog.archivefailed',
          'Could not change the channel archive state.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const removeMember = async (userId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.removeChannelMember(channel.id, userId)
      setChannelMembers((current) => current.filter((member) => member.userId !== userId))
    } catch {
      setError(
        translate(
          'auto.pie.chat.ChannelSettingsDialog.removefailed',
          'Could not remove this member.'
        )
      )
    } finally {
      setBusy(false)
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
                'auto.pie.chat.ChannelSettingsDialog.trigger',
                'Channel settings'
              )}
            >
              <Settings />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {translate('auto.pie.chat.ChannelSettingsDialog.trigger', 'Channel settings')}
        </TooltipContent>
      </Tooltip>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.pie.chat.ChannelSettingsDialog.title', 'Channel settings')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.pie.chat.ChannelSettingsDialog.description',
              'Manage #{{value0}} details, members, and archive state.',
              { value0: channel.name }
            )}
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger value="details">
              {translate('auto.pie.chat.ChannelSettingsDialog.details', 'Details')}
            </TabsTrigger>
            <TabsTrigger value="members">
              {translate('auto.pie.chat.ChannelSettingsDialog.members', 'Members')}
            </TabsTrigger>
            <TabsTrigger value="governance">
              {translate('auto.pie.chat.ChannelSettingsDialog.governance', 'Governance')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="channel-settings-name">
                {translate('auto.pie.chat.ChannelSettingsDialog.name', 'Name')}
              </Label>
              <Input
                id="channel-settings-name"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-settings-topic">
                {translate('auto.pie.chat.ChannelSettingsDialog.topic', 'Topic')}
              </Label>
              <Input
                id="channel-settings-topic"
                value={topic}
                maxLength={250}
                onChange={(event) => setTopic(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-settings-description">
                {translate('auto.pie.chat.ChannelSettingsDialog.fielddescription', 'Description')}
              </Label>
              <Textarea
                id="channel-settings-description"
                value={description}
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <p className="text-sm text-muted-foreground">
                {channel.archivedAt
                  ? translate(
                      'auto.pie.chat.ChannelSettingsDialog.archivedhelp',
                      'Restore this channel to allow new messages.'
                    )
                  : translate(
                      'auto.pie.chat.ChannelSettingsDialog.archivehelp',
                      'Archived channels stay readable but become read-only.'
                    )}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void setArchived(channel.archivedAt === null)}
              >
                {channel.archivedAt ? <ArchiveRestore /> : <Archive />}
                {channel.archivedAt
                  ? translate('auto.pie.chat.ChannelSettingsDialog.restore', 'Restore')
                  : translate('auto.pie.chat.ChannelSettingsDialog.archive', 'Archive')}
              </Button>
            </div>
          </TabsContent>
          <TabsContent
            value="members"
            className="max-h-80 space-y-1 overflow-y-auto pt-2 scrollbar-sleek"
          >
            {loadingMembers ? (
              <p className="py-3 text-sm text-muted-foreground">
                {translate('auto.pie.chat.ChannelSettingsDialog.loading', 'Loading…')}
              </p>
            ) : (
              channelMembers.map((member) => (
                <div
                  key={member.userId}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">
                      {memberName(member.userId, members, currentUserId)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {member.role === 'owner'
                        ? translate('auto.pie.chat.ChannelSettingsDialog.owner', 'Owner')
                        : translate('auto.pie.chat.ChannelSettingsDialog.member', 'Member')}
                    </p>
                  </div>
                  {member.userId !== currentUserId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={translate(
                        'auto.pie.chat.ChannelSettingsDialog.remove',
                        'Remove member'
                      )}
                      onClick={() => void removeMember(member.userId)}
                    >
                      <UserMinus />
                    </Button>
                  )}
                </div>
              ))
            )}
          </TabsContent>
          <TabsContent value="governance" className="pt-2">
            <ChannelGovernancePanel
              channel={channel}
              currentUserId={currentUserId}
              members={members}
              api={api}
              onUpdated={onUpdated}
            />
          </TabsContent>
        </Tabs>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            type="button"
            disabled={busy || !changed || name.trim().length === 0}
            onClick={() => void save()}
          >
            {busy
              ? translate('auto.pie.chat.ChannelSettingsDialog.saving', 'Saving…')
              : translate('auto.pie.chat.ChannelSettingsDialog.save', 'Save changes')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
