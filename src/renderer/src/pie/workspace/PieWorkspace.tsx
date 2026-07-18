import { useState } from 'react'
import {
  Bot,
  BookOpen,
  Boxes,
  Bug,
  ClipboardList,
  FileDiff,
  Gavel,
  KanbanSquare,
  MessagesSquare,
  PackageCheck,
  PlayCircle,
  ReceiptText,
  ShieldAlert,
  Video,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatScreen } from '../chat/ChatScreen'
import { PieResourceScreen } from './PieResourceScreen'
import { WorkItemBoard } from './WorkItemBoard'
import { PIE_DELIVERY_DOMAINS } from './pie-delivery-domains'
import { PIE_OPS_DOMAINS } from './pie-ops-domains'
import type { PieDomainConfig } from './pie-domain-types'

const ICONS: Record<string, LucideIcon> = {
  'change-requests': FileDiff,
  deliverables: PackageCheck,
  defects: Bug,
  risks: ShieldAlert,
  decisions: Gavel,
  'status-reports': ClipboardList,
  knowledge: BookOpen,
  runbooks: PlayCircle,
  assets: Boxes,
  invoices: ReceiptText,
  meetings: Video,
  'ai-entitlements': Bot
}

function NavItem({
  icon: Icon,
  label,
  active,
  onClick
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent',
        active && 'bg-sidebar-accent font-medium'
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </button>
  )
}

function NavSection({
  title,
  domains,
  active,
  onSelect
}: {
  title: string
  domains: readonly PieDomainConfig[]
  active: string
  onSelect: (key: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <p className="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {domains.map((d) => (
        <NavItem
          key={d.key}
          icon={ICONS[d.key] ?? FileDiff}
          label={d.label}
          active={active === d.key}
          onClick={() => onSelect(d.key)}
        />
      ))}
    </div>
  )
}

// The Pie desktop workspace: a left rail switching between Chat and each backend
// domain surface. Chat keeps its full screen; every other domain renders from the
// declarative registry through one generic PieResourceScreen.
export function PieWorkspace(): React.JSX.Element {
  const [active, setActive] = useState<string>('chat')
  const domain = [...PIE_DELIVERY_DOMAINS, ...PIE_OPS_DOMAINS].find((d) => d.key === active) ?? null

  return (
    <div className="grid h-full min-h-0 grid-cols-[13rem_minmax(0,1fr)]">
      <nav className="flex min-h-0 flex-col border-r border-border bg-sidebar">
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-3">
          <NavItem
            icon={MessagesSquare}
            label="Chat"
            active={active === 'chat'}
            onClick={() => setActive('chat')}
          />
          <NavItem
            icon={KanbanSquare}
            label="Board"
            active={active === 'board'}
            onClick={() => setActive('board')}
          />
          <NavSection
            title="Delivery"
            domains={PIE_DELIVERY_DOMAINS}
            active={active}
            onSelect={setActive}
          />
          <NavSection
            title="Operations"
            domains={PIE_OPS_DOMAINS}
            active={active}
            onSelect={setActive}
          />
        </ScrollArea>
      </nav>
      <div className="min-h-0">
        {domain ? (
          <PieResourceScreen key={domain.key} config={domain} />
        ) : active === 'board' ? (
          <WorkItemBoard />
        ) : (
          <ChatScreen />
        )}
      </div>
    </div>
  )
}
