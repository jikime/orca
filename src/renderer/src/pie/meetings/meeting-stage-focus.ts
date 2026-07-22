export type MeetingViewMode = 'gallery' | 'speaker'

export type MeetingStageParticipant = {
  identity: string
  local: boolean
  sharingScreen: boolean
}

export type MeetingStageFocus = {
  identity: string
  source: 'camera' | 'screen'
}

export function resolveMeetingStageFocus(
  participants: MeetingStageParticipant[],
  viewMode: MeetingViewMode,
  pinnedParticipantId: string | null,
  activeSpeakerIds: string[]
): MeetingStageFocus | null {
  const screenSharer = participants.find((participant) => participant.sharingScreen)
  if (screenSharer) {
    return { identity: screenSharer.identity, source: 'screen' }
  }
  if (viewMode === 'gallery') {
    return null
  }
  const pinned = participants.find((participant) => participant.identity === pinnedParticipantId)
  if (pinned) {
    return { identity: pinned.identity, source: 'camera' }
  }
  for (const identity of activeSpeakerIds) {
    if (participants.some((participant) => participant.identity === identity)) {
      return { identity, source: 'camera' }
    }
  }
  const fallback = participants.find((participant) => !participant.local) ?? participants[0]
  return fallback ? { identity: fallback.identity, source: 'camera' } : null
}
