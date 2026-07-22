import type { PieChatMember } from '../../../../shared/pie-chat-contract'

export function chatMemberDisplayName(
  userId: string,
  members: readonly PieChatMember[],
  currentUserId?: string,
  selfLabel = 'You'
): string {
  if (currentUserId === userId) {
    return selfLabel
  }
  return members.find((member) => member.userId === userId)?.displayName ?? userId.slice(0, 8)
}
