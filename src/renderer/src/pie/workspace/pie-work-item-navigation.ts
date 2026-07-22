import { setPieWorkspaceRoute } from './pie-workspace-route'

export type WorkItemNavigationTarget = { workItemId: string; projectId?: string }

let pendingTarget: WorkItemNavigationTarget | null = null
const listeners = new Set<() => void>()

export function queuePieWorkItemNavigation(target: WorkItemNavigationTarget): void {
  // Project-backed links return to that project's Work tab; unassigned direct
  // links still use the unfiltered hidden route.
  setPieWorkspaceRoute(target.projectId ? 'projects' : 'work-item')
  pendingTarget = target
  for (const listener of listeners) {
    listener()
  }
}

export function takePieWorkItemNavigation(): WorkItemNavigationTarget | null {
  const target = pendingTarget
  pendingTarget = null
  return target
}

export function subscribePieWorkItemNavigation(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
