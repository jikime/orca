import { cn } from '@/lib/utils'
import type { WorkItem } from './use-work-item-board'

const PRIORITY_TONE: Record<string, string> = {
  urgent: 'bg-destructive',
  high: 'bg-amber-500',
  medium: 'bg-sky-500',
  low: 'bg-muted-foreground/50'
}

export function WorkItemPriorityDot({ priority }: { priority: string }): React.JSX.Element | null {
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

export function WorkItemBoardCard({
  item,
  active,
  dragging,
  moving,
  onOpen,
  onPointerDown
}: {
  item: WorkItem
  active: boolean
  dragging: boolean
  moving: boolean
  onOpen: () => void
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
}): React.JSX.Element {
  return (
    <article
      aria-busy={moving || undefined}
      data-work-item-card={item.id}
      onPointerDown={onPointerDown}
      onClick={onOpen}
      className={cn(
        'rounded-lg border border-border bg-background p-2.5 shadow-xs transition-[border-color,box-shadow,opacity] hover:shadow-sm',
        moving ? 'cursor-wait opacity-70' : 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-50',
        active && 'border-ring ring-2 ring-ring/30'
      )}
    >
      <div className="flex items-center gap-1.5">
        <WorkItemPriorityDot priority={item.priority} />
        <span className="font-mono text-[11px] text-muted-foreground">{item.identifier}</span>
      </div>
      <p className="mt-1 text-[13px] leading-snug text-foreground">{item.title}</p>
    </article>
  )
}
