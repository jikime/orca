import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { usePieResource } from '../control-plane/use-pie-resource'
import { useWorkItemBoard, type WorkItem } from './use-work-item-board'
import { WorkItemDetail } from './WorkItemDetail'
import { translate } from '@/i18n/i18n'
import {
  subscribePieWorkItemNavigation,
  takePieWorkItemNavigation
} from './pie-work-item-navigation'
import { WorkItemBoardCard, WorkItemPriorityDot } from './WorkItemBoardCard'
import { useWorkItemBoardPointerDrag } from './use-work-item-board-pointer-drag'

export function WorkItemBoard({
  scope = 'all',
  fixedProjectId,
  initialSelectedId,
  listenForNavigation = true
}: {
  scope?: 'all' | 'mine'
  fixedProjectId?: string
  initialSelectedId?: string | null
  listenForNavigation?: boolean
} = {}): React.JSX.Element {
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [view, setView] = useState<'board' | 'list'>('board')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!listenForNavigation) {
      return
    }
    const openPending = (): void => {
      const target = takePieWorkItemNavigation()
      if (target) {
        setSelectedId(target.workItemId)
      }
    }
    openPending()
    return subscribePieWorkItemNavigation(openPending)
  }, [listenForNavigation])

  useEffect(() => {
    if (initialSelectedId) {
      setSelectedId(initialSelectedId)
    }
  }, [initialSelectedId])

  const projectId = fixedProjectId ?? selectedProjectId
  const board = useWorkItemBoard({
    ...(projectId ? { projectId } : {}),
    ...(scope === 'mine' ? { assignee: 'me' as const } : {})
  })
  const {
    boardRef,
    draggingId,
    overStateId: overCol,
    onCardPointerDown
  } = useWorkItemBoardPointerDrag({
    items: board.items,
    movingItemIds: board.movingItemIds,
    onMove: (item, stateId) => void board.move(item, stateId)
  })
  const projects =
    (usePieResource<Record<string, unknown>>('/projects').data?.items as
      | { id: string; name: string }[]
      | undefined) ?? []

  const items = board.items.filter((i) => {
    if (priorityFilter !== 'all' && (i.priority || 'none') !== priorityFilter) {
      return false
    }
    if (assigneeFilter === 'unassigned' && i.assigneeId) {
      return false
    }
    if (
      assigneeFilter !== 'all' &&
      assigneeFilter !== 'unassigned' &&
      i.assigneeId !== assigneeFilter
    ) {
      return false
    }
    return true
  })
  const byState = (id: string): WorkItem[] => items.filter((i) => i.stateId === id)
  const selected = board.items.find((i) => i.id === selectedId) ?? null

  if (!board.loading && !board.team) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {translate('auto.pie.workspace.WorkItemBoard.55fc58e108', 'No team in this org yet.')}
      </div>
    )
  }

  return (
    <div
      ref={boardRef}
      data-work-item-board=""
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">
          {scope === 'mine'
            ? translate('auto.pie.workspace.WorkItemBoard.mywork', 'My Work')
            : translate('auto.pie.workspace.WorkItemBoard.work', 'Work')}
        </h2>
        <div className="flex overflow-hidden rounded-md border border-input">
          {(['board', 'list'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                'px-2.5 py-1 text-xs capitalize transition-colors',
                view === v ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground'
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <FilterSelect
            value={priorityFilter}
            onChange={setPriorityFilter}
            placeholder={translate('auto.pie.workspace.WorkItemBoard.33422451f8', 'Priority')}
            options={[
              {
                value: 'all',
                label: translate('auto.pie.workspace.WorkItemBoard.9769d64796', 'All priorities')
              },
              {
                value: 'urgent',
                label: translate('auto.pie.workspace.WorkItemBoard.d3ad5c9f54', 'Urgent')
              },
              {
                value: 'high',
                label: translate('auto.pie.workspace.WorkItemBoard.1ad21becf8', 'High')
              },
              {
                value: 'medium',
                label: translate('auto.pie.workspace.WorkItemBoard.d14a042678', 'Medium')
              },
              {
                value: 'low',
                label: translate('auto.pie.workspace.WorkItemBoard.5f739cc800', 'Low')
              },
              {
                value: 'none',
                label: translate('auto.pie.workspace.WorkItemBoard.758d2790ab', 'No priority')
              }
            ]}
          />
          {scope !== 'mine' && (
            <FilterSelect
              value={assigneeFilter}
              onChange={setAssigneeFilter}
              placeholder={translate('auto.pie.workspace.WorkItemBoard.b565a2ab30', 'Assignee')}
              options={[
                {
                  value: 'all',
                  label: translate('auto.pie.workspace.WorkItemBoard.7561482dbe', 'All assignees')
                },
                {
                  value: 'unassigned',
                  label: translate('auto.pie.workspace.WorkItemBoard.71230ef6f0', 'Unassigned')
                },
                ...board.members.map((m) => ({
                  value: m.userId,
                  label: m.displayName || m.userId.slice(0, 8)
                }))
              ]}
            />
          )}
          {!fixedProjectId && (
            <FilterSelect
              value={projectId || 'all'}
              onChange={(v) => setSelectedProjectId(v === 'all' ? '' : v)}
              placeholder={translate('auto.pie.workspace.WorkItemBoard.f8420a103a', 'Project')}
              options={[
                {
                  value: 'all',
                  label: translate('auto.pie.workspace.WorkItemBoard.130caa9064', 'All projects')
                },
                ...projects.map((p) => ({ value: p.id, label: p.name }))
              ]}
            />
          )}
        </div>
      </header>

      {board.error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive">
          {board.error}
        </div>
      )}

      <div data-work-item-board-content="" className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div data-work-item-board-primary="" className="min-h-0 min-w-0 flex-1">
          {view === 'board' ? (
            <ScrollArea className="h-full">
              <div className="flex items-start gap-3 p-3">
                {board.columns.map((col) => (
                  <div
                    key={col.id}
                    data-work-item-state-drop-target={col.id}
                    className={cn(
                      'flex w-72 shrink-0 flex-col rounded-xl border border-border bg-card/40 transition-colors',
                      overCol === col.id && 'border-ring bg-accent/40'
                    )}
                  >
                    <div className="flex items-center gap-2 px-3 py-2">
                      <span className="text-[13px] font-semibold text-foreground">{col.name}</span>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {byState(col.id).length}
                      </span>
                    </div>
                    <div className="flex flex-col gap-2 px-2 pb-2">
                      {byState(col.id).map((item) => (
                        <WorkItemBoardCard
                          key={item.id}
                          item={item}
                          active={selectedId === item.id}
                          dragging={draggingId === item.id}
                          moving={board.movingItemIds.has(item.id)}
                          onOpen={() => setSelectedId(item.id)}
                          onPointerDown={(event) => onCardPointerDown(event, item)}
                        />
                      ))}
                      <Input
                        value={draft[col.id] ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, [col.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            void board.create(col.id, draft[col.id] ?? '')
                            setDraft((d) => ({ ...d, [col.id]: '' }))
                          }
                        }}
                        placeholder={translate(
                          'auto.pie.workspace.WorkItemBoard.7ebeac7b75',
                          '+ New issue'
                        )}
                        className="h-8 border-dashed bg-transparent text-[13px] shadow-none"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <ScrollArea className="h-full">
              <div className="flex flex-col">
                {board.columns.map((col) => (
                  <div key={col.id}>
                    <div className="sticky top-0 bg-muted/50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                      {col.name} · {byState(col.id).length}
                    </div>
                    {byState(col.id).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedId(item.id)}
                        className={cn(
                          'flex w-full items-center gap-2 border-b border-border/50 px-4 py-2 text-left hover:bg-accent',
                          selectedId === item.id && 'bg-accent'
                        )}
                      >
                        <WorkItemPriorityDot priority={item.priority} />
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {item.identifier}
                        </span>
                        <span className="truncate text-[13px] text-foreground">{item.title}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>

        {selected && (
          <WorkItemDetail
            key={selected.id}
            item={selected}
            projectName={projects.find((project) => project.id === selected.projectId)?.name}
            columns={board.columns}
            members={board.members}
            onMove={(s) => void board.move(selected, s)}
            onAssign={(a) => void board.assign(selected, a)}
            onSetPriority={(p) => void board.setPriority(selected, p)}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  )
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  options
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  options: { value: string; label: string }[]
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-40">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
