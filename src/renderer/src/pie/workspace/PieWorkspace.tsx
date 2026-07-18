import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatScreen } from '../chat/ChatScreen'
import { PieResourceScreen } from './PieResourceScreen'
import { PIE_DOMAINS } from './pie-domain-registry'

// The Pie desktop workspace: a left rail switching between Chat and each backend
// domain surface (change requests, knowledge, invoices, …). Chat keeps its own
// full screen; every other domain renders from the declarative registry.
export function PieWorkspace(): React.JSX.Element {
  const [active, setActive] = useState<string>('chat')
  const domain = PIE_DOMAINS.find((d) => d.key === active) ?? null

  return (
    <div className="grid h-full min-h-0 grid-cols-[184px_minmax(0,1fr)]">
      <nav className="flex min-h-0 flex-col border-r border-border bg-sidebar">
        <p className="px-3 pt-3 pb-1 text-xs font-semibold text-sidebar-foreground">Pie</p>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
          <button
            type="button"
            onClick={() => setActive('chat')}
            aria-current={active === 'chat' ? 'true' : undefined}
            className={cn(
              'w-full rounded-md px-2 py-1.5 text-left text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent',
              active === 'chat' && 'bg-sidebar-accent font-medium'
            )}
          >
            Chat
          </button>
          <p className="px-2 pt-3 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            Delivery & Ops
          </p>
          {PIE_DOMAINS.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => setActive(d.key)}
              aria-current={active === d.key ? 'true' : undefined}
              className={cn(
                'w-full rounded-md px-2 py-1.5 text-left text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent',
                active === d.key && 'bg-sidebar-accent font-medium'
              )}
            >
              {d.label}
            </button>
          ))}
        </ScrollArea>
      </nav>
      <div className="min-h-0">
        {domain ? <PieResourceScreen key={domain.key} config={domain} /> : <ChatScreen />}
      </div>
    </div>
  )
}
