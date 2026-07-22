import { useEffect, useRef } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { TopLevelView } from '../../../../shared/types'

type OrcaView = Exclude<TopLevelView, 'pie'>

export function SidebarModeTabs(): React.JSX.Element {
  const activeView = useAppStore((state) => state.activeView)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const lastOrcaView = useRef<OrcaView>(activeView === 'pie' ? 'terminal' : activeView)

  useEffect(() => {
    if (activeView !== 'pie') {
      lastOrcaView.current = activeView
    }
  }, [activeView])

  const mode = activeView === 'pie' ? 'pie' : 'orca'

  return (
    <Tabs
      value={mode}
      onValueChange={(value) => {
        setActiveView(value === 'pie' ? 'pie' : lastOrcaView.current)
      }}
      className="shrink-0 gap-0 px-2 pt-2 pb-1"
    >
      <TabsList
        aria-label={translate(
          'auto.components.sidebar.SidebarModeTabs.sections',
          'Sidebar sections'
        )}
        className="h-8 w-full bg-worktree-sidebar-foreground/5"
      >
        <TabsTrigger
          value="orca"
          className="h-6 text-xs text-worktree-sidebar-foreground/55 data-[state=active]:bg-worktree-sidebar-accent data-[state=active]:text-worktree-sidebar-accent-foreground dark:data-[state=active]:border-worktree-sidebar-border dark:data-[state=active]:bg-worktree-sidebar-accent"
        >
          {translate('auto.components.sidebar.SidebarModeTabs.orca', 'Orca')}
        </TabsTrigger>
        <TabsTrigger
          value="pie"
          className="h-6 text-xs text-worktree-sidebar-foreground/55 data-[state=active]:bg-worktree-sidebar-accent data-[state=active]:text-worktree-sidebar-accent-foreground dark:data-[state=active]:border-worktree-sidebar-border dark:data-[state=active]:bg-worktree-sidebar-accent"
        >
          {translate('auto.components.sidebar.SidebarModeTabs.pie', 'Pie')}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
