import type { PieMessage, PieMessageReaction } from '../../../../shared/pie-chat-contract'

// Pure local toggle of one emoji reaction so the bar updates instantly; the
// server's authoritative counts arrive via the returned message / realtime nudge.
export function toggleReactionLocally(message: PieMessage, emoji: string): PieMessage {
  const existing = message.reactions.find((reaction) => reaction.emoji === emoji)
  let reactions: PieMessageReaction[]
  if (!existing) {
    reactions = [...message.reactions, { emoji, count: 1, reactedByMe: true }]
  } else if (existing.reactedByMe) {
    // Remove my reaction; drop the entry when it was the last one.
    reactions = message.reactions
      .map((reaction) =>
        reaction.emoji === emoji
          ? { ...reaction, count: reaction.count - 1, reactedByMe: false }
          : reaction
      )
      .filter((reaction) => reaction.count > 0)
  } else {
    reactions = message.reactions.map((reaction) =>
      reaction.emoji === emoji
        ? { ...reaction, count: reaction.count + 1, reactedByMe: true }
        : reaction
    )
  }
  return { ...message, reactions }
}

export function isReactedByMe(message: PieMessage, emoji: string): boolean {
  return message.reactions.some((reaction) => reaction.emoji === emoji && reaction.reactedByMe)
}
