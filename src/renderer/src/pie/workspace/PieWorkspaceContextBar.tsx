import { ArrowLeft, PanelsTopLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { queuePieWorkItemNavigation } from './pie-work-item-navigation'

export function PieWorkspaceContextBar({
  worktreeId
}: {
  worktreeId: string | null
}): React.JSX.Element | null {
  const worktree = useAppStore((state) =>
    worktreeId ? state.getKnownWorktreeById(worktreeId) : undefined
  )
  const context = worktree?.pieWorkspaceContext

  if (!context) {
    return null
  }

  const returnToWorkItem = (): void => {
    // Why: the queued opaque ID survives the Pie view remount; a title or key
    // can change while work continues in this workspace.
    queuePieWorkItemNavigation({
      workItemId: context.workItemId,
      projectId: context.projectId
    })
    useAppStore.getState().setActiveView('pie')
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      <PanelsTopLeft className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-xs font-medium text-foreground">
        {context.projectName ??
          translate('auto.pie.workspace.PieWorkspaceContextBar.project', 'Pie project')}
      </span>
      <span className="text-xs text-muted-foreground">/</span>
      <span className="font-mono text-xs font-medium text-foreground">
        {context.workItemIdentifier}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {context.workItemTitle}
      </span>
      <Button type="button" size="xs" variant="outline" onClick={returnToWorkItem}>
        <ArrowLeft />
        {translate('auto.pie.workspace.PieWorkspaceContextBar.back', 'Back to work item')}
      </Button>
    </div>
  )
}
