import { useEffect, useMemo, useState } from 'react'
import { LayoutGrid, Rows3 } from 'lucide-react'
import { Track, type Participant } from 'livekit-client'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { translate } from '@/i18n/i18n'
import { MeetingParticipantAudio } from './MeetingParticipantAudio'
import { MeetingParticipantTile } from './MeetingParticipantTile'
import {
  resolveMeetingStageFocus,
  type MeetingViewMode,
  type MeetingStageParticipant
} from './meeting-stage-focus'

type MeetingCaption = {
  segmentId: string
  speaker: string
  text: string
  final: boolean
}

function hasVisibleTrack(participant: Participant, source: Track.Source): boolean {
  const publication = participant.getTrackPublication(source)
  return Boolean(publication?.track && !publication.isMuted)
}

function MeetingCaptions({
  captions,
  participantNames
}: {
  captions: MeetingCaption[]
  participantNames: Map<string, string>
}): React.JSX.Element | null {
  if (captions.length === 0) {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-3 z-10 mx-auto max-w-3xl rounded-lg bg-background/90 px-3 py-2 text-center text-xs text-foreground shadow-sm backdrop-blur-sm">
      {captions.slice(-2).map((caption) => (
        <p key={caption.segmentId} className={caption.final ? '' : 'text-muted-foreground'}>
          <span className="font-medium">
            {participantNames.get(caption.speaker) ?? caption.speaker}:{' '}
          </span>
          {caption.text}
        </p>
      ))}
    </div>
  )
}

export function MeetingStage({
  participants,
  localParticipant,
  activeSpeakerIds,
  captions
}: {
  participants: Participant[]
  localParticipant: Participant | undefined
  activeSpeakerIds: string[]
  captions: MeetingCaption[]
}): React.JSX.Element {
  const [viewMode, setViewMode] = useState<MeetingViewMode>('gallery')
  const [pinnedParticipantId, setPinnedParticipantId] = useState<string | null>(null)
  const speaking = useMemo(() => new Set(activeSpeakerIds), [activeSpeakerIds])
  const participantNames = useMemo(
    () =>
      new Map(
        participants.map((participant) => [
          participant.identity,
          participant.name || participant.identity
        ])
      ),
    [participants]
  )
  const stageParticipants: MeetingStageParticipant[] = participants.map((participant) => ({
    identity: participant.identity,
    local: participant === localParticipant,
    sharingScreen: hasVisibleTrack(participant, Track.Source.ScreenShare)
  }))
  const focus = resolveMeetingStageFocus(
    stageParticipants,
    viewMode,
    pinnedParticipantId,
    activeSpeakerIds
  )
  const focusedParticipant = focus
    ? participants.find((participant) => participant.identity === focus.identity)
    : undefined
  const stripParticipants = focus
    ? participants.filter(
        (participant) => focus.source === 'screen' || participant.identity !== focus.identity
      )
    : []

  useEffect(() => {
    if (
      pinnedParticipantId &&
      !participants.some((participant) => participant.identity === pinnedParticipantId)
    ) {
      setPinnedParticipantId(null)
    }
  }, [participants, pinnedParticipantId])

  const togglePin = (identity: string): void => {
    setPinnedParticipantId((current) => (current === identity ? null : identity))
    setViewMode('speaker')
  }

  const tile = (participant: Participant, className?: string): React.JSX.Element => (
    <MeetingParticipantTile
      key={participant.identity}
      participant={participant}
      local={participant === localParticipant}
      speaking={speaking.has(participant.identity)}
      pinned={pinnedParticipantId === participant.identity}
      onTogglePin={() => togglePin(participant.identity)}
      className={className}
    />
  )

  return (
    <div className="relative size-full min-h-0 overflow-hidden rounded-lg bg-muted/30">
      {participants
        .filter((participant) => participant !== localParticipant)
        .map((participant) => (
          <MeetingParticipantAudio key={participant.identity} participant={participant} />
        ))}
      <ButtonGroup
        className="absolute right-2 top-2 z-20"
        aria-label={translate('auto.pie.meetings.MeetingStage.view', 'Meeting view')}
      >
        <Button
          size="xs"
          variant={viewMode === 'gallery' ? 'secondary' : 'outline'}
          className="bg-background/90 backdrop-blur-sm"
          aria-pressed={viewMode === 'gallery'}
          onClick={() => setViewMode('gallery')}
        >
          <LayoutGrid />
          {translate('auto.pie.meetings.MeetingStage.gallery', 'Gallery')}
        </Button>
        <Button
          size="xs"
          variant={viewMode === 'speaker' ? 'secondary' : 'outline'}
          className="bg-background/90 backdrop-blur-sm"
          aria-pressed={viewMode === 'speaker'}
          onClick={() => setViewMode('speaker')}
        >
          <Rows3 />
          {translate('auto.pie.meetings.MeetingStage.speaker', 'Speaker')}
        </Button>
      </ButtonGroup>
      {focusedParticipant && focus ? (
        <div className="flex size-full min-h-0 flex-col gap-2 p-2 pt-10">
          <div className="relative min-h-0 flex-1">
            <MeetingParticipantTile
              participant={focusedParticipant}
              local={focusedParticipant === localParticipant}
              speaking={speaking.has(focusedParticipant.identity)}
              pinned={pinnedParticipantId === focusedParticipant.identity}
              onTogglePin={
                focus.source === 'camera' ? () => togglePin(focusedParticipant.identity) : undefined
              }
              source={focus.source === 'screen' ? Track.Source.ScreenShare : Track.Source.Camera}
              className="h-full min-h-0 w-full aspect-auto"
            />
            <MeetingCaptions captions={captions} participantNames={participantNames} />
          </div>
          {stripParticipants.length > 0 && (
            <div className="grid h-28 shrink-0 grid-flow-col auto-cols-[11rem] gap-2 overflow-x-auto pb-1 scrollbar-sleek">
              {stripParticipants.map((participant) => tile(participant, 'h-full min-h-0'))}
            </div>
          )}
        </div>
      ) : (
        <div className="relative size-full min-h-0">
          <div className="grid size-full grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] content-center gap-2 overflow-y-auto p-2 pt-10 scrollbar-sleek">
            {participants.map((participant) => tile(participant))}
          </div>
          <MeetingCaptions captions={captions} participantNames={participantNames} />
        </div>
      )}
    </div>
  )
}
