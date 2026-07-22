import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { apiGet, apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { queuePieWorkItemNavigation } from '../workspace/pie-work-item-navigation'
import type { MeetingActionItem } from './meeting-types'

type Team = { id: string; key: string; name: string }
type Project = { id: string; name: string }

export function MeetingActionWorkItemDialog({
  actionItem,
  open,
  onOpenChange,
  onChanged
}: {
  actionItem: MeetingActionItem
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}): React.JSX.Element {
  const [teams, setTeams] = useState<Team[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [teamId, setTeamId] = useState('')
  const [projectId, setProjectId] = useState('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setError(null)
    void Promise.all([
      apiGet<{ items: Team[] }>('/teams'),
      apiGet<{ items: Project[] }>('/projects')
    ])
      .then(([teamResponse, projectResponse]) => {
        setTeams(teamResponse.items)
        setProjects(projectResponse.items)
        setTeamId((current) => current || teamResponse.items[0]?.id || '')
        setProjectId(actionItem.projectId ?? 'none')
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [actionItem.projectId, open])

  const convert = async (): Promise<void> => {
    if (!teamId) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const converted = await apiPost<MeetingActionItem>(
        `/meeting-action-items/${actionItem.id}:convert-to-work-item`,
        { teamId, ...(projectId === 'none' ? {} : { projectId }) },
        resourceEtag('meeting-action-item', actionItem.version)
      )
      onChanged()
      onOpenChange(false)
      if (converted.workItemId) {
        queuePieWorkItemNavigation({ workItemId: converted.workItemId })
      }
    } catch (caught) {
      setError(
        caught instanceof PieApiError
          ? `${caught.code ?? caught.status}: ${caught.message}`
          : caught instanceof Error
            ? caught.message
            : String(caught)
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.pie.meetings.outcomes.convertTitle', 'Create work item')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.pie.meetings.outcomes.convertBody',
              'Create tracked work linked to this approved meeting action.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground">
            {actionItem.task}
          </p>
          <div className="space-y-2">
            <Label htmlFor="meeting-action-team">
              {translate('auto.pie.meetings.outcomes.team', 'Team')}
            </Label>
            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger id="meeting-action-team" className="w-full">
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
            <Label htmlFor="meeting-action-project">
              {translate('auto.pie.meetings.outcomes.project', 'Project')}
            </Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="meeting-action-project" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {translate('auto.pie.meetings.outcomes.noProject', 'No project')}
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
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button disabled={busy || !teamId} onClick={() => void convert()}>
            {busy
              ? translate('auto.pie.meetings.outcomes.converting', 'Creating…')
              : translate('auto.pie.meetings.outcomes.convert', 'Create work item')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
