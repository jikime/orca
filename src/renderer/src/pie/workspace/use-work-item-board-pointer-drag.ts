import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { WorkItem } from './use-work-item-board'

const POINTER_DRAG_THRESHOLD = 5
const COLUMN_SELECTOR = '[data-work-item-state-drop-target]'

type PointerDragState = {
  pointerId: number
  itemId: string
  startX: number
  startY: number
  currentX: number
  currentY: number
  sourceCard: HTMLElement
  preview: HTMLElement | null
  previewOffsetX: number
  previewOffsetY: number
  previousCursor: string
  previousUserSelect: string
  started: boolean
}

type WorkItemBoardPointerDragParams = {
  items: readonly WorkItem[]
  movingItemIds: ReadonlySet<string>
  onMove: (item: WorkItem, stateId: string) => void
}

function resolveTargetStateId(
  board: HTMLElement | null,
  item: WorkItem | undefined,
  x: number,
  y: number
): string | null {
  if (!board || !item) {
    return null
  }
  const pointed = document.elementFromPoint(x, y)
  if (!(pointed instanceof Element) || !board.contains(pointed)) {
    return null
  }
  const column = pointed.closest<HTMLElement>(COLUMN_SELECTOR)
  if (!column || !board.contains(column)) {
    return null
  }
  const stateId = column.dataset.workItemStateDropTarget
  return stateId && stateId !== item.stateId ? stateId : null
}

function createPointerPreview(state: PointerDragState): HTMLElement {
  const rect = state.sourceCard.getBoundingClientRect()
  const preview = state.sourceCard.cloneNode(true) as HTMLElement
  state.previewOffsetX = Math.min(Math.max(state.startX - rect.left, 0), rect.width)
  state.previewOffsetY = Math.min(Math.max(state.startY - rect.top, 0), rect.height)
  preview.removeAttribute('data-work-item-card')
  preview.setAttribute('aria-hidden', 'true')
  preview.setAttribute('data-work-item-pointer-preview', '')
  preview.style.position = 'fixed'
  preview.style.left = '0'
  preview.style.top = '0'
  preview.style.width = `${rect.width}px`
  preview.style.pointerEvents = 'none'
  preview.style.zIndex = '9999'
  preview.style.opacity = '0.92'
  document.body.appendChild(preview)
  return preview
}

function updatePointerPreview(state: PointerDragState): void {
  const left = state.currentX - state.previewOffsetX
  const top = state.currentY - state.previewOffsetY
  state.preview?.style.setProperty('transform', `translate3d(${left}px, ${top}px, 0)`)
}

export function useWorkItemBoardPointerDrag({
  items,
  movingItemIds,
  onMove
}: WorkItemBoardPointerDragParams): {
  boardRef: React.RefObject<HTMLDivElement | null>
  draggingId: string | null
  overStateId: string | null
  onCardPointerDown: (event: React.PointerEvent<HTMLElement>, item: WorkItem) => void
} {
  const boardRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<PointerDragState | null>(null)
  const itemsRef = useRef(items)
  const movingItemIdsRef = useRef(movingItemIds)
  const onMoveRef = useRef(onMove)
  const suppressClickUntilRef = useRef(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overStateId, setOverStateId] = useState<string | null>(null)

  // Why: document listeners remain stable for the whole gesture, so mutable refs
  // must expose the latest server-backed board state when the pointer is released.
  itemsRef.current = items
  movingItemIdsRef.current = movingItemIds
  onMoveRef.current = onMove

  const updateTarget = useCallback((state: PointerDragState): string | null => {
    const item = itemsRef.current.find((candidate) => candidate.id === state.itemId)
    const stateId = resolveTargetStateId(boardRef.current, item, state.currentX, state.currentY)
    setOverStateId(stateId)
    return stateId
  }, [])

  const stopPointerDrag = useCallback(
    (commit: boolean) => {
      const state = dragRef.current
      if (!state) {
        return
      }
      const item = itemsRef.current.find((candidate) => candidate.id === state.itemId)
      const targetStateId = state.started ? updateTarget(state) : null
      dragRef.current = null
      state.preview?.remove()
      document.body.style.cursor = state.previousCursor
      document.body.style.userSelect = state.previousUserSelect
      setDraggingId(null)
      setOverStateId(null)

      if (!state.started) {
        return
      }
      suppressClickUntilRef.current = performance.now() + 250
      if (commit && item && targetStateId && !movingItemIdsRef.current.has(item.id)) {
        onMoveRef.current(item, targetStateId)
      }
    },
    [updateTarget]
  )

  const startPointerDrag = useCallback((state: PointerDragState) => {
    state.started = true
    state.previousCursor = document.body.style.cursor
    state.previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    state.preview = createPointerPreview(state)
    updatePointerPreview(state)
    setDraggingId(state.itemId)
  }, [])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const state = dragRef.current
      if (!state || event.pointerId !== state.pointerId) {
        return
      }
      state.currentX = event.clientX
      state.currentY = event.clientY
      const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
      if (!state.started && distance >= POINTER_DRAG_THRESHOLD) {
        startPointerDrag(state)
      }
      if (!state.started) {
        return
      }
      event.preventDefault()
      updatePointerPreview(state)
      updateTarget(state)
    }

    const handlePointerUp = (event: PointerEvent): void => {
      const state = dragRef.current
      if (!state || event.pointerId !== state.pointerId) {
        return
      }
      state.currentX = event.clientX
      state.currentY = event.clientY
      if (state.started) {
        event.preventDefault()
      }
      stopPointerDrag(true)
    }

    const handlePointerCancel = (event: PointerEvent): void => {
      if (dragRef.current?.pointerId === event.pointerId) {
        stopPointerDrag(false)
      }
    }

    const handleClick = (event: MouseEvent): void => {
      if (performance.now() > suppressClickUntilRef.current) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }

    const handleBlur = (): void => stopPointerDrag(false)
    document.addEventListener('pointermove', handlePointerMove, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('pointercancel', handlePointerCancel, true)
    document.addEventListener('click', handleClick, true)
    window.addEventListener('blur', handleBlur)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('pointercancel', handlePointerCancel, true)
      document.removeEventListener('click', handleClick, true)
      window.removeEventListener('blur', handleBlur)
      stopPointerDrag(false)
    }
  }, [startPointerDrag, stopPointerDrag, updateTarget])

  const onCardPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, item: WorkItem): void => {
      if (
        event.button !== 0 ||
        event.pointerType === 'touch' ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        movingItemIdsRef.current.has(item.id)
      ) {
        return
      }
      dragRef.current = {
        pointerId: event.pointerId,
        itemId: item.id,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        sourceCard: event.currentTarget,
        preview: null,
        previewOffsetX: 0,
        previewOffsetY: 0,
        previousCursor: '',
        previousUserSelect: '',
        started: false
      }
    },
    []
  )

  return { boardRef, draggingId, overStateId, onCardPointerDown }
}
