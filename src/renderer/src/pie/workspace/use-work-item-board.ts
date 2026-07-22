import { useEffect, useRef, useState } from 'react'
import { apiPatch, apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import { translate } from '@/i18n/i18n'

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
  movingItemIds: ReadonlySet<string>
  members: BoardMember[]
  error: string | null
  clearError: () => void
  move: (item: WorkItem, toStateId: string) => Promise<void>
  create: (stateId: string, title: string) => Promise<void>
  assign: (item: WorkItem, assigneeId: string | null) => Promise<void>
  setPriority: (item: WorkItem, priority: string) => Promise<void>
}

export type WorkItemBoardQuery = {
  projectId?: string
  assignee?: 'me'
}

function message(e: unknown): string {
  return e instanceof PieApiError ? `${e.code ?? e.status}: ${e.message}` : String(e)
}

// Loads the delivery work-item board (team → states/columns + items) and the
// OCC-guarded mutations Linear-style boards need. Assignee names come from the
// chat member roster (memberships carry no display name).
export function buildWorkItemListPath(query: WorkItemBoardQuery): string {
  const params = new URLSearchParams()
  if (query.projectId) {
    params.set('projectId', query.projectId)
  }
  if (query.assignee) {
    params.set('assignee', query.assignee)
  }
  const encoded = params.toString()
  return encoded ? `/work-items?${encoded}` : '/work-items'
}

export function useWorkItemBoard(query: WorkItemBoardQuery = {}): WorkItemBoardData {
  const [error, setError] = useState<string | null>(null)
  const [members, setMembers] = useState<BoardMember[]>([])
  const [items, setItems] = useState<WorkItem[]>([])
  const movingItemIdsRef = useRef(new Set<string>())
  const [movingItemIds, setMovingItemIds] = useState<ReadonlySet<string>>(new Set())

  const teams = usePieResource<Record<string, unknown>>('/teams')
  const team = (teams.data?.items as BoardTeam[] | undefined)?.[0] ?? null
  const states = usePieResource<Record<string, unknown>>(
    team ? `/teams/${team.id}/workflow-states` : null
  )
  const itemsQuery = usePieResource<Record<string, unknown>>(
    team ? buildWorkItemListPath(query) : null
  )

  useEffect(() => {
    window.api?.pie?.chat
      ?.listMembers?.()
      .then((m) => setMembers(m as BoardMember[]))
      .catch(() => setMembers([]))
  }, [])

  useEffect(() => {
    const fetchedItems = (itemsQuery.data?.items as WorkItem[] | undefined) ?? []
    setItems((currentItems) =>
      fetchedItems.map((fetchedItem) => {
        if (!movingItemIdsRef.current.has(fetchedItem.id)) {
          return fetchedItem
        }
        // Why: a background refresh may finish before the move request; keep the
        // optimistic column until the OCC-guarded response becomes canonical.
        return currentItems.find((item) => item.id === fetchedItem.id) ?? fetchedItem
      })
    )
  }, [itemsQuery.data])

  const columns = ((states.data?.items as BoardState[] | undefined) ?? [])
    .slice()
    .sort((a, b) => a.sortKey - b.sortKey)
  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
      itemsQuery.refetch()
    } catch (e) {
      setError(message(e))
    }
  }

  const create = async (stateId: string, title: string): Promise<void> => {
    if (!team || !title.trim()) {
      return
    }
    await guard(async () => {
      const session = query.assignee === 'me' ? await window.api.pie.session.getState() : null
      if (query.assignee === 'me' && session?.status !== 'signed_in') {
        throw new Error(
          translate(
            'auto.pie.workspace.useWorkItemBoard.signInRequired',
            'Sign in to create work assigned to you.'
          )
        )
      }
      await apiPost('/work-items', {
        teamId: team.id,
        title: title.trim(),
        stateId,
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(session?.status === 'signed_in' ? { assigneeId: session.userId } : {})
      })
    })
  }

  const move = async (item: WorkItem, toStateId: string): Promise<void> => {
    if (item.stateId === toStateId || movingItemIdsRef.current.has(item.id)) {
      return
    }

    setError(null)
    movingItemIdsRef.current.add(item.id)
    setMovingItemIds(new Set(movingItemIdsRef.current))
    // Why: column movement should feel immediate, while server OCC still decides
    // whether the move is valid and supplies the next authoritative version.
    setItems((currentItems) =>
      currentItems.map((current) =>
        current.id === item.id ? { ...current, stateId: toStateId } : current
      )
    )

    try {
      const updated = await apiPost<WorkItem>(`/work-items/${item.id}:move-state`, {
        fromStateId: item.stateId,
        toStateId,
        workflowVersion: item.workflowVersion,
        expectedVersion: item.version
      })
      setItems((currentItems) =>
        currentItems.map((current) => (current.id === updated.id ? updated : current))
      )
      itemsQuery.refetch()
    } catch (caught) {
      setItems((currentItems) =>
        currentItems.map((current) => (current.id === item.id ? item : current))
      )
      setError(message(caught))
      itemsQuery.refetch()
    } finally {
      movingItemIdsRef.current.delete(item.id)
      setMovingItemIds(new Set(movingItemIdsRef.current))
    }
  }

  return {
    loading: teams.loading || states.loading || itemsQuery.loading,
    team,
    columns,
    items,
    movingItemIds,
    members,
    error,
    clearError: () => setError(null),
    move,
    create,
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
