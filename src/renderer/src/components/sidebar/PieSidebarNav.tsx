import { useTranslation } from 'react-i18next'
import {
  Bot,
  BookOpen,
  Boxes,
  Building2,
  FileDiff,
  FolderKanban,
  LifeBuoy,
  ListChecks,
  MessagesSquare,
  MonitorUp,
  PlayCircle,
  ReceiptText,
  ScrollText,
  Video,
  type LucideIcon
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  buildPieAdminDomains,
  buildPieCommunicationDomains,
  buildPieCustomerDomains,
  buildPieSupportDomains
} from '@/pie/workspace/pie-domain-registry'
import type { PieDomainConfig } from '@/pie/workspace/pie-domain-types'
import {
  setPieWorkspaceRoute,
  usePieWorkspaceRoute,
  type PieWorkspaceRoute
} from '@/pie/workspace/pie-workspace-route'

const ICONS: Record<string, LucideIcon> = {
  accounts: Building2,
  contracts: ScrollText,
  invoices: ReceiptText,
  tickets: LifeBuoy,
  'remote-sessions': MonitorUp,
  knowledge: BookOpen,
  runbooks: PlayCircle,
  assets: Boxes,
  meetings: Video,
  'ai-entitlements': Bot
}

type PieNavItem = { key: PieWorkspaceRoute; icon: LucideIcon; label: string }
type PieNavModule = {
  title: string
  items: readonly PieNavItem[]
  domains: readonly PieDomainConfig[]
}

function NavItem({ item, active }: { item: PieNavItem; active: boolean }): React.JSX.Element {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={() => setPieWorkspaceRoute(item.key)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
        active
          ? 'bg-worktree-sidebar-accent font-medium text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <Icon
        className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
        strokeWidth={active ? 2.25 : 1.75}
      />
      <span className="truncate">{item.label}</span>
    </button>
  )
}

function ModuleGroup({
  module,
  active
}: {
  module: PieNavModule
  active: string
}): React.JSX.Element {
  const domainItems = module.domains.map((domain) => ({
    key: domain.key as PieWorkspaceRoute,
    icon: ICONS[domain.key] ?? FileDiff,
    label: domain.label
  }))

  return (
    <section>
      <h2 className="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-worktree-sidebar-foreground/45">
        {module.title}
      </h2>
      {[...module.items, ...domainItems].map((item) => (
        <NavItem key={item.key} item={item} active={active === item.key} />
      ))}
    </section>
  )
}

export function PieSidebarNav(): React.JSX.Element {
  useTranslation()
  const active = usePieWorkspaceRoute()
  const modules: PieNavModule[] = [
    {
      title: translate('auto.pie.workspace.PieWorkspace.moduleCommunication', 'Communication'),
      items: [
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
      items: [
        {
          key: 'my-work',
          icon: ListChecks,
          label: translate('auto.pie.workspace.PieWorkspace.myWork', 'My Work')
        },
        {
          key: 'projects',
          icon: FolderKanban,
          label: translate('auto.pie.workspace.PieWorkspace.projects', 'Projects')
        }
      ],
      domains: []
    },
    {
      title: translate('auto.pie.workspace.PieWorkspace.moduleCustomer', 'Customer'),
      items: [],
      domains: buildPieCustomerDomains()
    },
    {
      title: translate('auto.pie.workspace.PieWorkspace.moduleSupport', 'Support'),
      items: [],
      domains: buildPieSupportDomains()
    },
    {
      title: translate('auto.pie.workspace.PieWorkspace.moduleAdmin', 'Admin'),
      items: [],
      domains: buildPieAdminDomains()
    }
  ]

  return (
    <ScrollArea
      className="min-h-0 flex-1"
      viewportClassName="px-2 pb-3"
      aria-label={translate('auto.components.sidebar.PieSidebarNav.navigation', 'Pie navigation')}
    >
      {modules.map((module) => (
        <ModuleGroup key={module.title} module={module} active={active} />
      ))}
    </ScrollArea>
  )
}
