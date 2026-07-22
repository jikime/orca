import type { MeetingScopeKind } from './meeting-types'
import { setPieWorkspaceRoute } from '../workspace/pie-workspace-route'

type MeetingNavigationTarget =
  | { meetingId: string; actionItemId?: string }
  | { create: { scopeKind: Exclude<MeetingScopeKind, 'none'>; scopeId: string; title?: string } }

let pendingTarget: MeetingNavigationTarget | null = null
const listeners = new Set<() => void>()

export function queuePieMeetingNavigation(target: MeetingNavigationTarget): void {
  setPieWorkspaceRoute('meetings')
  pendingTarget = target
  for (const listener of listeners) {
    listener()
  }
}

export function takePieMeetingNavigation(): MeetingNavigationTarget | null {
  const target = pendingTarget
  pendingTarget = null
  return target
}

export function subscribePieMeetingNavigation(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
