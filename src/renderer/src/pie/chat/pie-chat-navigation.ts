import type { PieChannel } from '../../../../shared/pie-chat-contract'
import { setPieWorkspaceRoute } from '../workspace/pie-workspace-route'

export type PieChatNavigationTarget = {
  channelId: string
  messageId?: string
  channel?: PieChannel
}

let pendingTarget: PieChatNavigationTarget | null = null
const listeners = new Set<() => void>()

export function queuePieChatNavigation(target: PieChatNavigationTarget): void {
  setPieWorkspaceRoute('chat')
  pendingTarget = target
  for (const listener of listeners) {
    listener()
  }
}

export function takePieChatNavigation(): PieChatNavigationTarget | null {
  const target = pendingTarget
  pendingTarget = null
  return target
}

export function subscribePieChatNavigation(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
