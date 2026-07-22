import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, Link2, Plus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  isSamePieWorkspaceContext,
  type PieWorkspaceContext
} from '../../../../shared/pie-workspace-context'

type WorkspaceChoice = {
  id: string
  name: string
  path: string
  context?: PieWorkspaceContext
}

function openWorkspace(workspaceId: string): void {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    activateAndRevealFolderWorkspace(scope.folderWorkspaceId, {
      sidebarRevealBehavior: 'auto'
    })
    return
  }
  activateAndRevealWorktree(workspaceId, { sidebarRevealBehavior: 'auto' })
}

export function WorkItemWorkspaceDialog({
  open,
  onOpenChange,
  context,
  canCreate
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: PieWorkspaceContext
  canCreate: boolean
}): React.JSX.Element {
  const worktrees = useAllWorktrees()
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces)
  const updateWorktreeMeta = useAppStore((state) => state.updateWorktreeMeta)
  const openModal = useAppStore((state) => state.openModal)
  const [selectedId, setSelectedId] = useState('')
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choices = useMemo<WorkspaceChoice[]>(
    () => [
      ...worktrees.map((worktree) => ({
        id: worktree.id,
        name: worktree.displayName,
        path: worktree.path,
        context: worktree.pieWorkspaceContext
      })),
      ...folderWorkspaces.map((workspace) => ({
        id: folderWorkspaceKey(workspace.id),
        name: workspace.name,
        path: workspace.folderPath,
        context: workspace.pieWorkspaceContext
      }))
    ],
    [folderWorkspaces, worktrees]
  )
  const linked = choices.filter(
    (choice) => choice.context && isSamePieWorkspaceContext(choice.context, context)
  )
  // Why: selecting an already-bound workspace would silently steal it from a
  // different Pie item, so rebinding stays out of this fast-path picker.
  const available = choices.filter((choice) => !choice.context)

  useEffect(() => {
    if (!open) {
      setSelectedId('')
      setError(null)
      setLinking(false)
    }
  }, [open])

  const handleOpen = (workspaceId: string): void => {
    onOpenChange(false)
    openWorkspace(workspaceId)
  }

  const handleLink = async (): Promise<void> => {
    if (!selectedId || !canCreate || linking) {
      return
    }
    setLinking(true)
    setError(null)
    try {
      await updateWorktreeMeta(selectedId, { pieWorkspaceContext: context })
      handleOpen(selectedId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLinking(false)
    }
  }

  const handleCreate = (): void => {
    if (!canCreate) {
      return
    }
    onOpenChange(false)
    openModal('new-workspace-composer', {
      prefilledName: `${context.workItemIdentifier} ${context.workItemTitle}`,
      pieWorkspaceContext: context,
      telemetrySource: 'unknown'
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.pie.workspace.WorkItemWorkspaceDialog.title', 'Open in Workspace')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.pie.workspace.WorkItemWorkspaceDialog.description',
              'Continue in a linked workspace, connect an existing workspace, or create a new one.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {translate('auto.pie.workspace.WorkItemWorkspaceDialog.linked', 'Linked workspaces')}
            </h4>
            {linked.length > 0 ? (
              <div className="space-y-1">
                {linked.map((workspace) => (
                  <Button
                    key={workspace.id}
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start gap-3 px-2 py-2 text-left"
                    onClick={() => handleOpen(workspace.id)}
                  >
                    <FolderOpen className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{workspace.name}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {workspace.path}
                      </span>
                    </span>
                  </Button>
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                {translate(
                  'auto.pie.workspace.WorkItemWorkspaceDialog.empty',
                  'No workspace is linked to this work item yet.'
                )}
              </p>
            )}
          </section>

          {available.length > 0 && (
            <section className="space-y-2 border-t border-border pt-4">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {translate(
                  'auto.pie.workspace.WorkItemWorkspaceDialog.existing',
                  'Connect existing workspace'
                )}
              </h4>
              <div className="flex gap-2">
                <Select value={selectedId} onValueChange={setSelectedId} disabled={!canCreate}>
                  <SelectTrigger className="min-w-0 flex-1">
                    <SelectValue
                      placeholder={translate(
                        'auto.pie.workspace.WorkItemWorkspaceDialog.select',
                        'Select a workspace'
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {available.map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!selectedId || !canCreate || linking}
                  onClick={() => void handleLink()}
                >
                  <Link2 />
                  {linking
                    ? translate('auto.pie.workspace.WorkItemWorkspaceDialog.linking', 'Connecting…')
                    : translate('auto.pie.workspace.WorkItemWorkspaceDialog.connect', 'Connect')}
                </Button>
              </div>
            </section>
          )}

          {!canCreate && (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.pie.workspace.WorkItemWorkspaceDialog.executeRequired',
                'workspace.execute permission is required to connect or create a workspace.'
              )}
            </p>
          )}
          {error && <p className="text-xs font-medium text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" disabled={!canCreate} onClick={handleCreate}>
            <Plus />
            {translate('auto.pie.workspace.WorkItemWorkspaceDialog.create', 'Create new workspace')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
