import { useState } from 'react'
import { Loader2, MessageSquareText, SquareTerminal, Video } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { BoardMember, BoardState, WorkItem } from './use-work-item-board'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { queuePieChatNavigation } from '../chat/pie-chat-navigation'
import { queuePieMeetingNavigation } from '../meetings/pie-meeting-navigation'
import { usePieResource } from '../control-plane/use-pie-resource'
import { WorkItemWorkspaceDialog } from './WorkItemWorkspaceDialog'
import { resolvePieWorkspaceAccess, type PieWorkspaceAccess } from './pie-workspace-access'

const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const
const META = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'

type WorkItemSourceBinding = {
  kind: 'chat_message' | 'meeting_action_item'
  sourceId: string
  containerId: string
  containerLabel: string
  createdAt: string
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className={META}>{label}</span>
      {children}
    </div>
  )
}

export function WorkItemDetail({
  item,
  projectName,
  columns,
  members,
  onMove,
  onAssign,
  onSetPriority,
  onClose
}: {
  item: WorkItem
  projectName?: string
  columns: BoardState[]
  members: BoardMember[]
  onMove: (toStateId: string) => void
  onAssign: (assigneeId: string | null) => void
  onSetPriority: (priority: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [workspaceAccess, setWorkspaceAccess] = useState<PieWorkspaceAccess | null>(null)
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const sourceQuery = usePieResource<{ items: WorkItemSourceBinding[] }>(
    `/work-items/${item.id}/source-bindings`
  )
  const sourceBindings = sourceQuery.data?.items ?? []
  const legacyChatSource = item.description?.match(
    /Converted from chat message ([0-9a-f-]{36}) in channel ([0-9a-f-]{36})\./i
  )

  const openWorkspace = async (): Promise<void> => {
    if (workspaceBusy) {
      return
    }
    setWorkspaceBusy(true)
    setWorkspaceError(null)
    try {
      const result = resolvePieWorkspaceAccess(
        { ...item, ...(projectName ? { projectName } : {}) },
        await window.api.pie.session.getState()
      )
      if (typeof result === 'string') {
        const error = {
          project_required: translate(
            'auto.pie.workspace.WorkItemDetail.projectRequired',
            'Assign this work item to a project before opening a workspace.'
          ),
          sign_in_required: translate(
            'auto.pie.workspace.WorkItemDetail.signInRequired',
            'Sign in to Pie before opening a workspace.'
          ),
          open_forbidden: translate(
            'auto.pie.workspace.WorkItemDetail.openForbidden',
            'You do not have permission to open workspaces for this item.'
          )
        }[result]
        setWorkspaceError(error)
        return
      }
      setWorkspaceAccess(result)
      setWorkspaceDialogOpen(true)
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWorkspaceBusy(false)
    }
  }

  const openSource = (source: WorkItemSourceBinding): void => {
    if (source.kind === 'chat_message') {
      queuePieChatNavigation({ channelId: source.containerId, messageId: source.sourceId })
    } else {
      queuePieMeetingNavigation({ meetingId: source.containerId, actionItemId: source.sourceId })
    }
    // Why: this detail also appears in Orca's general Tasks view, so source
    // routing must also make the Pie workspace visible.
    useAppStore.getState().setActiveView('pie')
  }

  return (
    <>
      <aside
        data-work-item-detail=""
        className="flex w-[24rem] max-w-full min-w-0 shrink-0 flex-col border-l border-border bg-card"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="font-mono text-xs text-muted-foreground">{item.identifier}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
          >
            {translate('auto.pie.workspace.WorkItemDetail.8f37fea8b7', 'Close')}
          </button>
        </div>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4 scrollbar-sleek">
          <h3 className="text-base leading-snug font-semibold text-foreground">{item.title}</h3>

          <div className="space-y-1.5">
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={workspaceBusy}
              onClick={() => void openWorkspace()}
            >
              {workspaceBusy ? <Loader2 className="animate-spin" /> : <SquareTerminal />}
              {translate('auto.pie.workspace.WorkItemDetail.openWorkspace', 'Open in Workspace')}
            </Button>
            {workspaceError && (
              <p className="text-xs font-medium text-destructive">{workspaceError}</p>
            )}
          </div>

          <Field label={translate('auto.pie.workspace.WorkItemDetail.2434c8f9ee', 'Status')}>
            <Select value={item.stateId} onValueChange={onMove}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {columns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={translate('auto.pie.workspace.WorkItemDetail.69f14263ba', 'Priority')}>
            <Select value={item.priority || 'none'} onValueChange={onSetPriority}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={translate('auto.pie.workspace.WorkItemDetail.6794705376', 'Assignee')}>
            <Select
              value={item.assigneeId ?? 'unassigned'}
              onValueChange={(v) => onAssign(v === 'unassigned' ? null : v)}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue
                  placeholder={translate(
                    'auto.pie.workspace.WorkItemDetail.81f3aa6605',
                    'Unassigned'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">
                  {translate('auto.pie.workspace.WorkItemDetail.81f3aa6605', 'Unassigned')}
                </SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.displayName || m.userId.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {item.description && (
            <Field
              label={translate('auto.pie.workspace.WorkItemDetail.description', 'Description')}
            >
              <p className="text-sm whitespace-pre-wrap text-foreground">{item.description}</p>
            </Field>
          )}

          {(sourceBindings.length > 0 ||
            (!sourceQuery.loading && sourceBindings.length === 0 && legacyChatSource)) && (
            <Field label={translate('auto.pie.workspace.WorkItemDetail.source', 'Source')}>
              <div className="flex flex-col gap-2">
                {sourceBindings.map((source) => (
                  <Button
                    key={`${source.kind}:${source.sourceId}`}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="justify-start"
                    onClick={() => openSource(source)}
                  >
                    {source.kind === 'chat_message' ? <MessageSquareText /> : <Video />}
                    <span className="truncate">
                      {source.kind === 'chat_message'
                        ? `${translate('auto.pie.workspace.WorkItemDetail.openSourceMessage', 'Open source message')} · #${source.containerLabel}`
                        : `${translate('auto.pie.workspace.WorkItemDetail.openSourceMeeting', 'Open source meeting')} · ${source.containerLabel}`}
                    </span>
                  </Button>
                ))}
                {sourceBindings.length === 0 && legacyChatSource && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="justify-start"
                    onClick={() => {
                      queuePieChatNavigation({
                        channelId: legacyChatSource[2]!,
                        messageId: legacyChatSource[1]!
                      })
                      useAppStore.getState().setActiveView('pie')
                    }}
                  >
                    <MessageSquareText />
                    {translate(
                      'auto.pie.workspace.WorkItemDetail.openSourceMessage',
                      'Open source message'
                    )}
                  </Button>
                )}
              </div>
            </Field>
          )}
        </div>
      </aside>
      {workspaceAccess && (
        <WorkItemWorkspaceDialog
          open={workspaceDialogOpen}
          onOpenChange={setWorkspaceDialogOpen}
          context={workspaceAccess.context}
          canCreate={workspaceAccess.canCreate}
        />
      )}
    </>
  )
}
