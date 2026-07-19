import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  BookOpen,
  Boxes,
  Bug,
  Building2,
  ClipboardList,
  FileDiff,
  Gavel,
  KanbanSquare,
  LifeBuoy,
  MessagesSquare,
  PackageCheck,
  PlayCircle,
  ReceiptText,
  ScrollText,
  ShieldAlert,
  Video,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatScreen } from '../chat/ChatScreen'
import { MeetingWorkspace } from '../meetings/MeetingWorkspace'
import { PieResourceScreen } from './PieResourceScreen'
import { WorkItemBoard } from './WorkItemBoard'
import {
  buildPiePortalDomains,
  buildPieCustomerDomains,
  buildPieSupportDomains,
  buildPieCommunicationDomains,
  buildPieAdminDomains
} from './pie-domain-registry'
import type { PieDomainConfig } from './pie-domain-types'

const ICONS: Record<string, LucideIcon> = {
  'change-requests': FileDiff,
  deliverables: PackageCheck,
  defects: Bug,
  risks: ShieldAlert,
  decisions: Gavel,
  'status-reports': ClipboardList,
  accounts: Building2,
  contracts: ScrollText,
  invoices: ReceiptText,
  tickets: LifeBuoy,
  knowledge: BookOpen,
  runbooks: PlayCircle,
  assets: Boxes,
  meetings: Video,
  'ai-entitlements': Bot
}

// A special (non-resource) surface shown at the top of its module — Chat and Board
// are full custom screens rather than declarative registry entries.
type SpecialItem = { key: string; icon: LucideIcon; label: string }

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

function ModuleGroup({
  title,
  specials,
  domains,
  active,
  onSelect
}: {
  title: string
  specials: readonly SpecialItem[]
  domains: readonly PieDomainConfig[]
  active: string
  onSelect: (key: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <p className="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {specials.map((s) => (
        <NavItem
          key={s.key}
          icon={s.icon}
          label={s.label}
          active={active === s.key}
          onClick={() => onSelect(s.key)}
        />
      ))}
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

// The Pie desktop workspace: a left rail organized by the documented module IA
// (Communication / Work Portal / Customer / Support / Admin). Chat and Board keep
// their full custom screens; every other surface renders from the declarative
// registry through one generic PieResourceScreen.
export function PieWorkspace(): React.JSX.Element {
  // Subscribe to language changes so module titles and domain labels re-resolve on
  // switch; the registries are cheap enough to rebuild each render.
  useTranslation()
  const [active, setActive] = useState<string>('chat')

  const modules = [
    {
      title: translate('auto.pie.workspace.PieWorkspace.moduleCommunication', 'Communication'),
      specials: [
        {
          key: 'chat',
          icon: MessagesSquare,
          label: translate('auto.pie.workspace.PieWorkspace.962a528982', 'Chat')
        }
      ],
      domains: buildPieCommunicationDomains()
    },
    {
      title: translate('auto.pie.workspace.PieWorkspace.moduleWorkPortal', 'Work Portal'),
      specials: [
        {
          key: 'board',
          icon: KanbanSquare,
          label: translate('auto.pie.workspace.PieWorkspace.1e7b750215', 'Board')
        }
      ],
      domains: buildPiePortalDomains()
    },
    {
      title: translate('auto.pie.workspace.PieWorkspace.moduleCustomer', 'Customer'),
      specials: [] as SpecialItem[],
      domains: buildPieCustomerDomains()
    },
    {
      title: translate('auto.pie.workspace.PieWorkspace.moduleSupport', 'Support'),
      specials: [] as SpecialItem[],
      domains: buildPieSupportDomains()
    },
    {
      title: translate('auto.pie.workspace.PieWorkspace.moduleAdmin', 'Admin'),
      specials: [] as SpecialItem[],
      domains: buildPieAdminDomains()
    }
  ]

  const domain = modules.flatMap((m) => m.domains).find((d) => d.key === active) ?? null

  return (
    <div className="grid h-full min-h-0 grid-cols-[13rem_minmax(0,1fr)]">
      <nav className="flex min-h-0 flex-col border-r border-border bg-sidebar">
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-3">
          {modules.map((m) => (
            <ModuleGroup
              key={m.title}
              title={m.title}
              specials={m.specials}
              domains={m.domains}
              active={active}
              onSelect={setActive}
            />
          ))}
        </ScrollArea>
      </nav>
      <div className="min-h-0">
        {active === 'meetings' ? (
          <MeetingWorkspace />
        ) : domain ? (
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
