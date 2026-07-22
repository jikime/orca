import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { TimelineMessage } from './pie-chat-controller'
import { apiGet, apiPostWithIdempotencyKey, PieApiError } from '../control-plane/pie-api-client'
import { queuePieWorkItemNavigation } from '../workspace/pie-work-item-navigation'
import { translate } from '@/i18n/i18n'

type Team = { id: string; key: string; name: string }
type Project = { id: string; name: string }
type LinkedWorkItem = { id: string; identifier: string; title: string }
type MessageWorkItemLink = { workItemId: string }

type MessageWorkItemDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  channelId: string
  assigneeId: string
  message: TimelineMessage | null
}

function defaultTitle(message: TimelineMessage | null): string {
  return (
    message?.body
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? ''
  ).slice(0, 500)
}

function MessageWorkItemDialogSession({
  open,
  onOpenChange,
  channelId,
  assigneeId,
  message
}: MessageWorkItemDialogProps): React.JSX.Element {
  const [teams, setTeams] = useState<Team[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [teamId, setTeamId] = useState('')
  const [projectId, setProjectId] = useState('none')
  const [priority, setPriority] = useState('none')
  const [title, setTitle] = useState(() => defaultTitle(message))
  const [loading, setLoading] = useState(open && message !== null)
  const [creating, setCreating] = useState(false)
  const [linkedWorkItem, setLinkedWorkItem] = useState<LinkedWorkItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const idempotencyKey = useRef(globalThis.crypto.randomUUID())

  useEffect(() => {
    if (!open || !message) {
      return
    }
    let cancelled = false
    const load = async (): Promise<void> => {
      const links = await apiGet<{ items: MessageWorkItemLink[] }>(
        `/channels/${channelId}/messages/${message.id}/work-items`
      )
      const existingId = links.items[0]?.workItemId
      if (existingId) {
        try {
          const existing = await apiGet<LinkedWorkItem>(`/work-items/${existingId}`)
          if (!cancelled) {
            setLinkedWorkItem(existing)
          }
          return
        } catch {
          // Why: cross-schema links cannot use a database FK. If an old link is
          // stale, the conversion endpoint repairs it inside its transaction.
        }
      }
      const [teamResponse, projectResponse] = await Promise.all([
        apiGet<{ items: Team[] }>('/teams'),
        apiGet<{ items: Project[] }>('/projects')
      ])
      if (!cancelled) {
        setTeams(teamResponse.items)
        setProjects(projectResponse.items)
        setTeamId(teamResponse.items[0]?.id ?? '')
      }
    }
    void load()
      .catch(() => {
        if (!cancelled) {
          setError(
            translate(
              'auto.pie.chat.MessageWorkItemDialog.loadfailed',
              'Could not load the linked work item, teams, and projects.'
            )
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [channelId, message, open])

  const create = async (): Promise<void> => {
    if (!message || !teamId || !title.trim()) {
      return
    }
    setCreating(true)
    setError(null)
    try {
      const result = await apiPostWithIdempotencyKey<LinkedWorkItem>(
        `/channels/${channelId}/messages/${message.id}/work-items`,
        {
          teamId,
          title: title.trim(),
          priority,
          assigneeId,
          ...(projectId === 'none' ? {} : { projectId })
        },
        idempotencyKey.current
      )
      setLinkedWorkItem(result)
    } catch (caught) {
      setError(
        caught instanceof PieApiError
          ? `${caught.code ?? caught.status}: ${caught.message}`
          : translate(
              'auto.pie.chat.MessageWorkItemDialog.createfailed',
              'Could not create the work item.'
            )
      )
    } finally {
      setCreating(false)
    }
  }

  const openCreated = (): void => {
    if (!linkedWorkItem) {
      return
    }
    onOpenChange(false)
    queuePieWorkItemNavigation({ workItemId: linkedWorkItem.id })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {linkedWorkItem
              ? translate('auto.pie.chat.MessageWorkItemDialog.linkedTitle', 'Linked work item')
              : translate('auto.pie.chat.MessageWorkItemDialog.title', 'Create work item')}
          </DialogTitle>
          <DialogDescription>
            {linkedWorkItem
              ? translate(
                  'auto.pie.chat.MessageWorkItemDialog.linkedDescription',
                  'Open the tracked work linked to this message.'
                )
              : translate(
                  'auto.pie.chat.MessageWorkItemDialog.description',
                  'Turn this message into tracked work with a link back to the conversation.'
                )}
          </DialogDescription>
        </DialogHeader>
        {linkedWorkItem ? (
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium text-muted-foreground">{linkedWorkItem.identifier}</p>
            <p className="mt-1 text-sm text-foreground">{linkedWorkItem.title}</p>
          </div>
        ) : loading ? (
          <p className="py-4 text-sm text-muted-foreground">
            {translate('auto.pie.chat.MessageWorkItemDialog.loading', 'Loading…')}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="message-work-item-title">
                {translate('auto.pie.chat.MessageWorkItemDialog.worktitle', 'Title')}
              </Label>
              <Input
                id="message-work-item-title"
                value={title}
                maxLength={500}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="message-work-item-team">
                  {translate('auto.pie.chat.MessageWorkItemDialog.team', 'Team')}
                </Label>
                <Select value={teamId} onValueChange={setTeamId}>
                  <SelectTrigger id="message-work-item-team" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.key} · {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="message-work-item-priority">
                  {translate('auto.pie.chat.MessageWorkItemDialog.priority', 'Priority')}
                </Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger id="message-work-item-priority" className="w-full">
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
            </div>
            <div className="space-y-2">
              <Label htmlFor="message-work-item-project">
                {translate('auto.pie.chat.MessageWorkItemDialog.project', 'Project')}
              </Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="message-work-item-project" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {translate('auto.pie.chat.MessageWorkItemDialog.noproject', 'No project')}
                  </SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          {linkedWorkItem ? (
            <Button type="button" onClick={openCreated}>
              {translate('auto.pie.chat.MessageWorkItemDialog.open', 'Open work item')}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={loading || creating || !teamId || !title.trim()}
              onClick={() => void create()}
            >
              {creating
                ? translate('auto.pie.chat.MessageWorkItemDialog.creating', 'Creating…')
                : translate('auto.pie.chat.MessageWorkItemDialog.create', 'Create')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function MessageWorkItemDialog(props: MessageWorkItemDialogProps): React.JSX.Element {
  // Why: each source gets an isolated form and retry key; reopening a message
  // must never inherit another message's target selections or success state.
  return <MessageWorkItemDialogSession key={props.message?.id ?? 'closed'} {...props} />
}
