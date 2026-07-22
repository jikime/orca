// @vitest-environment happy-dom

import React, { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

import { MessageDeleteDialog } from './MessageDeleteDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('MessageDeleteDialog', () => {
  it('requires and submits a reason for moderator deletion', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <MessageDeleteDialog open requireReason onOpenChange={vi.fn()} onConfirm={onConfirm} />
      )
    })

    const deleteButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete'
    ) as HTMLButtonElement
    expect(deleteButton.disabled).toBe(true)
    act(() =>
      fireEvent.change(container?.querySelector('textarea') as Element, {
        target: { value: 'policy violation' }
      })
    )
    expect(deleteButton.disabled).toBe(false)
    await act(async () => fireEvent.click(deleteButton))
    expect(onConfirm).toHaveBeenCalledWith('policy violation')
  })
})
