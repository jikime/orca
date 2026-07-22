import type { TimelineMessage } from './pie-chat-controller'

function timelineKey(message: TimelineMessage): string {
  return message.optimisticId ?? message.id
}

// Realtime refreshes return only the newest page. Merge it into any older pages
// already loaded so a background nudge never collapses the user's scroll history.
export function mergeChatTimeline(
  current: readonly TimelineMessage[],
  incoming: readonly TimelineMessage[]
): TimelineMessage[] {
  const byId = new Map(current.map((message) => [timelineKey(message), message]))
  for (const message of incoming) {
    byId.set(timelineKey(message), message)
  }
  return [...byId.values()].toSorted((left, right) => {
    const time = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    return time === 0 ? left.id.localeCompare(right.id) : time
  })
}
