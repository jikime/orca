const STORAGE_PREFIX = 'orca.pie.chat.scroll-position.v1'

export type ChatScrollPosition = {
  scrollTop: number
  scrollHeight: number
  atBottom: boolean
}

export function chatScrollPositionKey(
  ownerId: string,
  channelId: string,
  threadRootMessageId?: string
): string {
  return `${STORAGE_PREFIX}:${ownerId}:${channelId}:${threadRootMessageId ?? 'root'}`
}

export function readChatScrollPosition(key: string): ChatScrollPosition | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Record<
      string,
      unknown
    > | null
    if (
      !value ||
      typeof value.scrollTop !== 'number' ||
      typeof value.scrollHeight !== 'number' ||
      typeof value.atBottom !== 'boolean'
    ) {
      return null
    }
    return {
      scrollTop: Math.max(0, value.scrollTop),
      scrollHeight: Math.max(0, value.scrollHeight),
      atBottom: value.atBottom
    }
  } catch {
    return null
  }
}

export function writeChatScrollPosition(key: string, position: ChatScrollPosition): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(position))
  } catch {
    // Scroll restoration is an enhancement and must not block the timeline.
  }
}
