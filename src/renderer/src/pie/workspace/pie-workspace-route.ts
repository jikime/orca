import { useSyncExternalStore } from 'react'

export type PieWorkspaceRoute =
  | 'chat'
  | 'meetings'
  | 'my-work'
  | 'projects'
  | 'work-item'
  | 'accounts'
  | 'contracts'
  | 'invoices'
  | 'tickets'
  | 'remote-sessions'
  | 'knowledge'
  | 'runbooks'
  | 'assets'
  | 'ai-entitlements'

let activeRoute: PieWorkspaceRoute = 'chat'
const listeners = new Set<() => void>()

export function getPieWorkspaceRoute(): PieWorkspaceRoute {
  return activeRoute
}

export function setPieWorkspaceRoute(route: PieWorkspaceRoute): void {
  if (activeRoute === route) {
    return
  }
  activeRoute = route
  for (const listener of listeners) {
    listener()
  }
}

export function subscribePieWorkspaceRoute(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePieWorkspaceRoute(): PieWorkspaceRoute {
  // Module state keeps each Pie user's last location while its content is unmounted.
  return useSyncExternalStore(
    subscribePieWorkspaceRoute,
    getPieWorkspaceRoute,
    getPieWorkspaceRoute
  )
}
