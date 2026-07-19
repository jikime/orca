export type MeetingStatus = 'scheduled' | 'live' | 'ended' | 'cancelled'

export type MeetingResource = {
  id: string
  organizationId: string
  title: string
  scopeKind: 'project' | 'ticket' | 'none'
  scopeId: string | null
  hostUserId: string
  scheduledStart: string | null
  scheduledEnd: string | null
  status: MeetingStatus
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingParticipant = {
  id: string
  organizationId: string
  meetingId: string
  userId: string
  role: 'host' | 'participant'
  consentRecording: boolean
  joinedAt: string | null
  leftAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingMinutes = {
  id: string
  organizationId: string
  meetingId: string
  summary: string
  sourceType: 'manual' | 'ai'
  reviewStatus: 'unreviewed' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: string | null
  status: 'draft' | 'finalized'
  authorUserId: string
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingMediaToken = {
  serverUrl: string
  roomName: string
  token: string
  expiresAt: string
  participant: MeetingParticipant
}

export type MeetingRecording = {
  id: string
  organizationId: string
  meetingId: string
  objectRef: string | null
  status: 'pending' | 'available' | 'failed'
  durationSeconds: number | null
  startedAt: string
  stoppedAt: string | null
  errorCode: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingProcessingJob = {
  id: string
  organizationId: string
  meetingId: string
  recordingId: string
  jobType: 'transcribe' | 'summarize'
  status: 'queued' | 'processing' | 'completed' | 'failed'
  attempts: number
  lastError: string | null
  transcriptId: string | null
  minutesId: string | null
  createdAt: string
  updatedAt: string
}

export type MeetingTranscript = {
  id: string
  organizationId: string
  meetingId: string
  content: string | null
  segments: unknown
  source: 'live_caption' | 'post_recording' | 'ai'
  language: string | null
  version: number
  createdAt: string
  updatedAt: string
}
