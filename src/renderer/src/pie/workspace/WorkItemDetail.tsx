import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { BoardMember, BoardState, WorkItem } from './use-work-item-board'
import { translate } from '@/i18n/i18n'

const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const
const META = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'

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
  columns,
  members,
  onMove,
  onAssign,
  onSetPriority,
  onClose
}: {
  item: WorkItem
  columns: BoardState[]
  members: BoardMember[]
  onMove: (toStateId: string) => void
  onAssign: (assigneeId: string | null) => void
  onSetPriority: (priority: string) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <aside className="flex w-[24rem] shrink-0 flex-col border-l border-border bg-card">
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
      <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">
        <h3 className="text-base leading-snug font-semibold text-foreground">{item.title}</h3>

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
          <Field label="Description">
            <p className="text-sm whitespace-pre-wrap text-foreground">{item.description}</p>
          </Field>
        )}
      </div>
    </aside>
  )
}
