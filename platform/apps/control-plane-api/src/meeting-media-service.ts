export type MeetingMediaRole = 'host' | 'co_host' | 'presenter' | 'participant'

export type MeetingMediaToken = {
  token: string
  expiresAt: string
}

export type MeetingMediaRecordingSession = {
  videoEgressId: string
  audioEgressId: string | null
  transcriptionDispatchId: string | null
}

export type MeetingMediaPresenceWebhookEvent = {
  eventId: string
  eventType: 'participant_joined' | 'participant_left'
  roomName: string
  participantIdentity: string
  occurredAt: string
}

export type MeetingMediaEgressWebhookEvent = {
  eventId: string
  eventType: 'egress_ended'
  roomName: string
  egressId: string
  succeeded: boolean
  durationSeconds: number
  errorCode: string | null
  occurredAt: string
}

export type MeetingMediaWebhookEvent =
  | MeetingMediaPresenceWebhookEvent
  | MeetingMediaEgressWebhookEvent

export interface MeetingMediaService {
  readonly serverUrl: string
  diagnoseConnectivity(): Promise<{ reachable: boolean; latencyMs: number }>
  ensureRoom(input: {
    roomName: string
    organizationId: string
    meetingId: string
    title: string
  }): Promise<void>
  closeRoom(roomName: string): Promise<void>
  startRecording(input: {
    roomName: string
    organizationId: string
    meetingId: string
    recordingId: string
    captureTypes: readonly ('recording' | 'transcription' | 'ai_notes')[]
  }): Promise<MeetingMediaRecordingSession>
  stopRecording(input: {
    roomName: string
    videoEgressId: string | null
    audioEgressId: string | null
    transcriptionDispatchId: string | null
  }): Promise<void>
  issueParticipantToken(input: {
    roomName: string
    userId: string
    role: MeetingMediaRole
  }): Promise<MeetingMediaToken>
  muteParticipantMicrophone(input: { roomName: string; userId: string }): Promise<boolean>
  removeParticipant(input: { roomName: string; userId: string }): Promise<void>
  receiveWebhook(
    rawBody: string,
    authorization: string | undefined
  ): Promise<MeetingMediaWebhookEvent | null>
}

const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ROOM_PATTERN = new RegExp(`^pie_(${UUID_PART})_(${UUID_PART})$`, 'i')

export function meetingMediaRoomName(organizationId: string, meetingId: string): string {
  return `pie_${organizationId}_${meetingId}`
}

export function parseMeetingMediaRoomName(
  roomName: string
): { organizationId: string; meetingId: string } | null {
  const match = ROOM_PATTERN.exec(roomName)
  if (!match?.[1] || !match[2]) return null
  return { organizationId: match[1], meetingId: match[2] }
}
