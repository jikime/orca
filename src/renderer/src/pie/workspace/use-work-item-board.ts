import { useEffect, useState } from 'react'
import { apiPatch, apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'

export type BoardTeam = { id: string; name: string }
export type BoardState = { id: string; name: string; category: string; sortKey: number }
export type BoardMember = { userId: string; displayName: string }
export type WorkItem = {
  id: string
  identifier: string
  title: string
  description?: string
  stateId: string
  priority: string
  assigneeId: string | null
  projectId: string | null
  version: number
  workflowVersion: number
}

export type WorkItemBoardData = {
  loading: boolean
  team: BoardTeam | null
  columns: BoardState[]
  items: WorkItem[]
  members: BoardMember[]
  error: string | null
  clearError: () => void
  move: (item: WorkItem, toStateId: string) => Promise<void>
  create: (stateId: string, title: string) => Promise<void>
  assign: (item: WorkItem, assigneeId: string | null) => Promise<void>
  setPriority: (item: WorkItem, priority: string) => Promise<void>
}

function message(e: unknown): string {
  return e instanceof PieApiError ? `${e.code ?? e.status}: ${e.message}` : String(e)
}

// Loads the delivery work-item board (team → states/columns + items) and the
// OCC-guarded mutations Linear-style boards need. Assignee names come from the
// chat member roster (memberships carry no display name).
export function useWorkItemBoard(projectId: string): WorkItemBoardData {
  const [error, setError] = useState<string | null>(null)
  const [members, setMembers] = useState<BoardMember[]>([])

  const teams = usePieResource<Record<string, unknown>>('/teams')
  const team = (teams.data?.items as BoardTeam[] | undefined)?.[0] ?? null
  const states = usePieResource<Record<string, unknown>>(
    team ? `/teams/${team.id}/workflow-states` : null
  )
  const itemsQuery = usePieResource<Record<string, unknown>>(
    team ? `/work-items${projectId ? `?projectId=${projectId}` : ''}` : null
  )

  useEffect(() => {
    window.api?.pie?.chat
      ?.listMembers?.()
      .then((m) => setMembers(m as BoardMember[]))
      .catch(() => setMembers([]))
  }, [])

  const columns = ((states.data?.items as BoardState[] | undefined) ?? [])
    .slice()
    .sort((a, b) => a.sortKey - b.sortKey)
  const items = (itemsQuery.data?.items as WorkItem[] | undefined) ?? []

  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
      itemsQuery.refetch()
    } catch (e) {
      setError(message(e))
    }
  }

  return {
    loading: teams.loading || states.loading || itemsQuery.loading,
    team,
    columns,
    items,
    members,
    error,
    clearError: () => setError(null),
    move: (item, toStateId) =>
      item.stateId === toStateId
        ? Promise.resolve()
        : guard(() =>
            apiPost(`/work-items/${item.id}:move-state`, {
              fromStateId: item.stateId,
              toStateId,
              workflowVersion: item.workflowVersion,
              expectedVersion: item.version
            })
          ),
    create: (stateId, title) =>
      !team || !title.trim()
        ? Promise.resolve()
        : guard(() =>
            apiPost('/work-items', {
              teamId: team.id,
              title: title.trim(),
              stateId,
              ...(projectId ? { projectId } : {})
            })
          ),
    assign: (item, assigneeId) =>
      guard(() =>
        apiPost(`/work-items/${item.id}:assign`, { assigneeId, expectedVersion: item.version })
      ),
    setPriority: (item, priority) =>
      guard(() =>
        apiPatch(`/work-items/${item.id}`, { priority }, resourceEtag('work-item', item.version))
      )
  }
}
