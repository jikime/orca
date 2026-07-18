import { useState } from 'react'
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

const PRIORITY_TONE: Record<string, string> = {
  urgent: 'bg-destructive',
  high: 'bg-amber-500',
  medium: 'bg-sky-500',
  low: 'bg-muted-foreground/50'
}

function PriorityDot({ priority }: { priority: string }): React.JSX.Element | null {
  if (!priority || priority === 'none') {
    return null
  }
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        PRIORITY_TONE[priority] ?? 'bg-muted-foreground/40'
      )}
      title={priority}
    />
  )
}

function Card({
  item,
  active,
  onOpen,
  onDragStart
}: {
  item: WorkItem
  active: boolean
  onOpen: () => void
  onDragStart: (e: React.DragEvent) => void
}): React.JSX.Element {
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      className={cn(
        'cursor-grab rounded-lg border border-border bg-background p-2.5 shadow-xs transition-shadow hover:shadow-sm active:cursor-grabbing',
        active && 'border-ring ring-2 ring-ring/30'
      )}
    >
      <div className="flex items-center gap-1.5">
        <PriorityDot priority={item.priority} />
        <span className="font-mono text-[11px] text-muted-foreground">{item.identifier}</span>
      </div>
      <p className="mt-1 text-[13px] leading-snug text-foreground">{item.title}</p>
    </article>
  )
}

export function WorkItemBoard(): React.JSX.Element {
  const [projectId, setProjectId] = useState('')
  const [view, setView] = useState<'board' | 'list'>('board')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})

  const board = useWorkItemBoard(projectId)
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

  const onDragStartCard = (e: React.DragEvent, item: WorkItem): void => {
    e.dataTransfer.setData('text/plain', item.id)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDropCol = (e: React.DragEvent, stateId: string): void => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    const dragged = board.items.find((i) => i.id === id)
    if (dragged) {
      void board.move(dragged, stateId)
    }
    setOverCol(null)
  }

  if (!board.loading && !board.team) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No team in this org yet.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">Board</h2>
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
            placeholder="Priority"
            options={[
              { value: 'all', label: 'All priorities' },
              { value: 'urgent', label: 'Urgent' },
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'low', label: 'Low' },
              { value: 'none', label: 'No priority' }
            ]}
          />
          <FilterSelect
            value={assigneeFilter}
            onChange={setAssigneeFilter}
            placeholder="Assignee"
            options={[
              { value: 'all', label: 'All assignees' },
              { value: 'unassigned', label: 'Unassigned' },
              ...board.members.map((m) => ({
                value: m.userId,
                label: m.displayName || m.userId.slice(0, 8)
              }))
            ]}
          />
          <FilterSelect
            value={projectId || 'all'}
            onChange={(v) => setProjectId(v === 'all' ? '' : v)}
            placeholder="Project"
            options={[
              { value: 'all', label: 'All projects' },
              ...projects.map((p) => ({ value: p.id, label: p.name }))
            ]}
          />
        </div>
      </header>

      {board.error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive">
          {board.error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          {view === 'board' ? (
            <ScrollArea className="h-full">
              <div className="flex items-start gap-3 p-3">
                {board.columns.map((col) => (
                  <div
                    key={col.id}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setOverCol(col.id)
                    }}
                    onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
                    onDrop={(e) => onDropCol(e, col.id)}
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
                        <Card
                          key={item.id}
                          item={item}
                          active={selectedId === item.id}
                          onOpen={() => setSelectedId(item.id)}
                          onDragStart={(e) => onDragStartCard(e, item)}
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
                        placeholder="+ New issue"
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
                        <PriorityDot priority={item.priority} />
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
            item={selected}
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
