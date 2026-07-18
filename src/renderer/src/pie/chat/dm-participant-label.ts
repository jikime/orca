import type { PieChannel, PieChatMember } from '../../../../shared/pie-chat-contract'

// The typed channel contract exposes only name/kind; a DM's participants ride on
// passthrough fields the control-plane mirrors from its ChannelResource. Read the
// plausible keys defensively rather than assuming a single shape.
const PARTICIPANT_KEYS = ['memberUserIds', 'participantUserIds', 'participantIds'] as const

function participantIds(channel: PieChannel): string[] {
  const record = channel as Record<string, unknown>
  for (const key of PARTICIPANT_KEYS) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value.filter((id): id is string => typeof id === 'string')
    }
  }
  return []
}

// The label for a DM row: the OTHER participant(s). Resolve ids against the org
// roster; fall back to the backend-provided channel name, then an id slice —
// mirroring MessageTimeline's authorLabel fallback so unresolved DMs still read.
export function dmParticipantLabel(
  channel: PieChannel,
  members: PieChatMember[],
  currentUserId: string
): string {
  const others = participantIds(channel).filter((id) => id !== currentUserId)
  const byId = new Map(members.map((member) => [member.userId, member.displayName]))
  const resolved = others.map((id) => byId.get(id)).filter((name): name is string => Boolean(name))
  if (resolved.length > 0) {
    return resolved.join(', ')
  }
  if (channel.name.trim().length > 0) {
    return channel.name
  }
  return channel.id.slice(0, 8)
}
