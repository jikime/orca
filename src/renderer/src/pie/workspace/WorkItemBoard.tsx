import { useMemo, useState } from 'react'
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
import { apiPost, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'

type Team = { id: string; name: string }
type WorkflowState = { id: string; name: string; category: string; sortKey: number }
type WorkItem = {
  id: string
  identifier: string
  title: string
  stateId: string
  priority: string
  assigneeId: string | null
  version: number
  workflowVersion: number
}

const PRIORITY_TONE: Record<string, string> = {
  urgent: 'bg-destructive',
  high: 'bg-amber-500',
  medium: 'bg-sky-500',
  low: 'bg-muted-foreground/50'
}

// Linear-style board: workflow states are columns, work items are draggable
// cards. A drop calls :move-state (OCC in the body, so no If-Match header).
export function WorkItemBoard(): React.JSX.Element {
  const [projectId, setProjectId] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})

  const teams = usePieResource<Record<string, unknown>>('/teams')
  const team = (teams.data?.items as Team[] | undefined)?.[0] ?? null
  const statesQuery = usePieResource<Record<string, unknown>>(
    team ? `/teams/${team.id}/workflow-states` : null
  )
  const projectsQuery = usePieResource<Record<string, unknown>>('/projects')
  const itemsQuery = usePieResource<Record<string, unknown>>(
    team ? `/work-items${projectId ? `?projectId=${projectId}` : ''}` : null
  )

  const columns = useMemo(
    () =>
      ((statesQuery.data?.items as WorkflowState[] | undefined) ?? [])
        .slice()
        .sort((a, b) => a.sortKey - b.sortKey),
    [statesQuery.data]
  )
  const items = (itemsQuery.data?.items as WorkItem[] | undefined) ?? []
  const projects = (projectsQuery.data?.items as { id: string; name: string }[] | undefined) ?? []
  const byState = (stateId: string): WorkItem[] => items.filter((i) => i.stateId === stateId)

  const refetch = (): void => itemsQuery.refetch()

  const move = (item: WorkItem, toStateId: string): void => {
    if (item.stateId === toStateId) {
      return
    }
    setError(null)
    void apiPost(`/work-items/${item.id}:move-state`, {
      fromStateId: item.stateId,
      toStateId,
      workflowVersion: item.workflowVersion,
      expectedVersion: item.version
    })
      .then(refetch)
      .catch((e: unknown) =>
        setError(e instanceof PieApiError ? `${e.code ?? e.status}: ${e.message}` : String(e))
      )
  }

  const addItem = (stateId: string): void => {
    const title = (draft[stateId] ?? '').trim()
    if (!title || !team) {
      return
    }
    void apiPost('/work-items', {
      teamId: team.id,
      title,
      stateId,
      ...(projectId ? { projectId } : {})
    })
      .then(() => {
        setDraft((d) => ({ ...d, [stateId]: '' }))
        refetch()
      })
      .catch((e: unknown) =>
        setError(e instanceof PieApiError ? `${e.code ?? e.status}: ${e.message}` : String(e))
      )
  }

  if (!teams.loading && !team) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No team in this org yet.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">Board</h2>
        <span className="text-xs text-muted-foreground">{team?.name}</span>
        <div className="ml-auto">
          <Select value={projectId || undefined} onValueChange={setProjectId}>
            <SelectTrigger size="sm" className="w-56">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive">
          {error}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex h-full min-h-0 items-start gap-3 p-3">
          {columns.map((col) => {
            const colItems = byState(col.id)
            return (
              <div
                key={col.id}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOverCol(col.id)
                }}
                onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
                onDrop={() => {
                  const dragged = items.find((i) => i.id === dragId)
                  if (dragged) {
                    move(dragged, col.id)
                  }
                  setDragId(null)
                  setOverCol(null)
                }}
                className={cn(
                  'flex w-72 shrink-0 flex-col rounded-xl border border-border bg-card/40 transition-colors',
                  overCol === col.id && 'border-ring bg-accent/40'
                )}
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="text-[13px] font-semibold text-foreground">{col.name}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {colItems.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 px-2 pb-2">
                  {colItems.map((item) => (
                    <article
                      key={item.id}
                      draggable
                      onDragStart={() => setDragId(item.id)}
                      onDragEnd={() => setDragId(null)}
                      className={cn(
                        'cursor-grab rounded-lg border border-border bg-background p-2.5 shadow-xs transition-shadow hover:shadow-sm active:cursor-grabbing',
                        dragId === item.id && 'opacity-50'
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        {item.priority && item.priority !== 'none' && (
                          <span
                            className={cn(
                              'size-2 shrink-0 rounded-full',
                              PRIORITY_TONE[item.priority] ?? 'bg-muted-foreground/40'
                            )}
                            title={item.priority}
                          />
                        )}
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {item.identifier}
                        </span>
                      </div>
                      <p className="mt-1 text-[13px] leading-snug text-foreground">{item.title}</p>
                    </article>
                  ))}
                  <Input
                    value={draft[col.id] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [col.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        addItem(col.id)
                      }
                    }}
                    placeholder="+ New issue"
                    className="h-8 border-dashed bg-transparent text-[13px] shadow-none"
                  />
                </div>
              </div>
            )
          })}
          {columns.length === 0 && !statesQuery.loading && (
            <p className="p-4 text-sm text-muted-foreground">No workflow states.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
