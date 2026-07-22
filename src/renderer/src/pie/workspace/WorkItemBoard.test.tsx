// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkItemBoardData } from './use-work-item-board'

const move = vi.fn().mockResolvedValue(undefined)

const board: WorkItemBoardData = {
  loading: false,
  team: { id: 'team-1', name: 'Core' },
  columns: [
    { id: 'state-todo', name: 'Todo', category: 'unstarted', sortKey: 0 },
    { id: 'state-done', name: 'Done', category: 'completed', sortKey: 1 }
  ],
  items: [
    {
      id: 'work-item-1',
      identifier: 'CORE-7',
      title: 'Prepare release',
      stateId: 'state-todo',
      priority: 'high',
      assigneeId: null,
      projectId: null,
      version: 1,
      workflowVersion: 1
    }
  ],
  movingItemIds: new Set(),
  members: [],
  error: null,
  clearError: vi.fn(),
  move,
  create: vi.fn(),
  assign: vi.fn(),
  setPriority: vi.fn()
}

vi.mock('./use-work-item-board', () => ({
  useWorkItemBoard: () => board
}))

vi.mock('../control-plane/use-pie-resource', () => ({
  usePieResource: () => ({ data: { items: [] }, loading: false, error: null, refetch: vi.fn() })
}))

import { WorkItemBoard } from './WorkItemBoard'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  move.mockClear()
})

describe('WorkItemBoard drag and drop', () => {
  it('moves a card into another workflow column with pointer input', () => {
    const screen = render(<WorkItemBoard scope="mine" listenForNavigation={false} />)
    const card = screen.container.querySelector('[data-work-item-card="work-item-1"]')
    const target = screen.container.querySelector('[data-work-item-state-drop-target="state-done"]')
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)

    fireEvent.pointerDown(card as Element, {
      button: 0,
      pointerId: 7,
      pointerType: 'mouse',
      clientX: 10,
      clientY: 10
    })
    fireEvent.pointerMove(document, { pointerId: 7, clientX: 40, clientY: 10 })

    expect(target?.className).toContain('border-ring')
    expect(document.querySelector('[data-work-item-pointer-preview]')).not.toBeNull()

    fireEvent.pointerUp(document, { pointerId: 7, clientX: 40, clientY: 10 })
    expect(move).toHaveBeenCalledWith(board.items[0], 'state-done')
    expect(document.querySelector('[data-work-item-pointer-preview]')).toBeNull()
  })

  it('keeps a short pointer gesture as a click instead of moving the card', () => {
    const screen = render(<WorkItemBoard scope="mine" listenForNavigation={false} />)
    const card = screen.container.querySelector('[data-work-item-card="work-item-1"]')
    const target = screen.container.querySelector('[data-work-item-state-drop-target="state-done"]')
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)

    fireEvent.pointerDown(card as Element, {
      button: 0,
      pointerId: 8,
      pointerType: 'mouse',
      clientX: 10,
      clientY: 10
    })
    fireEvent.pointerMove(document, { pointerId: 8, clientX: 12, clientY: 11 })
    fireEvent.pointerUp(document, { pointerId: 8, clientX: 12, clientY: 11 })

    expect(move).not.toHaveBeenCalled()
    expect(document.querySelector('[data-work-item-pointer-preview]')).toBeNull()
  })

  it('does not expose native draggable behavior in Electron', () => {
    const screen = render(<WorkItemBoard scope="mine" listenForNavigation={false} />)
    const card = screen.container.querySelector('[data-work-item-card="work-item-1"]')

    expect(card?.hasAttribute('draggable')).toBe(false)
  })

  it('lets the board shrink when the detail panel opens', () => {
    const screen = render(<WorkItemBoard scope="mine" listenForNavigation={false} />)
    const card = screen.container.querySelector('[data-work-item-card="work-item-1"]')
    fireEvent.click(card as Element)

    const board = screen.container.querySelector('[data-work-item-board]')
    const content = screen.container.querySelector('[data-work-item-board-content]')
    const primary = screen.container.querySelector('[data-work-item-board-primary]')
    const detail = screen.container.querySelector('[data-work-item-detail]')

    // Why: Radix ScrollArea exposes column width as intrinsic content; every
    // flex boundary must release that minimum or the fixed detail gets clipped.
    expect(board?.className).toContain('min-w-0')
    expect(content?.className).toContain('min-w-0')
    expect(content?.className).toContain('overflow-hidden')
    expect(primary?.className).toContain('min-w-0')
    expect(detail?.className).toContain('max-w-full')
  })
})
