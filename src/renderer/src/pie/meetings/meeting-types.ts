export type MeetingStatus = 'scheduled' | 'live' | 'ended' | 'cancelled'
export type MeetingScopeKind = 'project' | 'ticket' | 'remote_session' | 'none'
export type MeetingRecurrence = 'none' | 'daily' | 'weekly' | 'monthly'
export type MeetingCaptureType =
  | 'recording'
  | 'transcription'
  | 'ai_notes'
  | 'presentation_screenshot'

export type MeetingResource = {
  id: string
  organizationId: string
  title: string
  scopeKind: MeetingScopeKind
  scopeId: string | null
  hostUserId: string
  scheduledStart: string | null
  scheduledEnd: string | null
  timeZone: string
  recurrence: MeetingRecurrence
  seriesId: string
  occurrenceIndex: number
  status: MeetingStatus
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingCalendarProvider = 'google_workspace' | 'microsoft_365'

export type MeetingCalendarLink = {
  id: string
  organizationId: string
  meetingId: string
  provider: MeetingCalendarProvider
  calendarId: string
  eventId: string | null
  webUrl: string | null
  syncStatus: 'pending' | 'synced' | 'failed'
  lastError: string | null
  lastSyncedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingGuestLink = {
  id: string
  organizationId: string
  meetingId: string
  identityMode: 'account_required' | 'limited_guest'
  visibility: 'meeting_only' | 'meeting_and_recap'
  expiresAt: string
  revokedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingParticipant = {
  id: string
  organizationId: string
  meetingId: string
  userId: string
  role: 'host' | 'co_host' | 'presenter' | 'participant'
  accessStatus: 'invited' | 'waiting' | 'admitted' | 'denied' | 'blocked'
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

export type MeetingMediaDiagnostics = {
  status: 'ready' | 'degraded' | 'unavailable'
  controlPlane: 'ready'
  media: 'ready' | 'degraded' | 'unavailable'
  latencyMs: number | null
  checkedAt: string
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
  captureTypes: MeetingCaptureType[]
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingCaptureConsent = {
  id: string
  organizationId: string
  meetingId: string
  participantId: string
  captureType: MeetingCaptureType
  policyVersion: number
  purpose: string
  status: 'pending' | 'granted' | 'denied' | 'revoked'
  currentPolicy: boolean
  grantedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingGovernance = {
  meetingId: string
  organizationId: string
  policyVersion: number
  purpose: string
  retentionDays: number | null
  retentionUntil: string | null
  legalHold: boolean
  captureStatus: 'idle' | 'active' | 'paused' | 'stopped'
  activeCaptureTypes: MeetingCaptureType[]
  deletionStatus: 'active' | 'queued' | 'processing' | 'completed' | 'failed'
  deletionRequestedAt: string | null
  deletionRequestedBy: string | null
  deletionReason: string | null
  deletionCompletedAt: string | null
  deletionAttempts: number
  deletionLastError: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingGovernanceAuditEntry = {
  id: string
  actorId: string | null
  action: string
  occurredAt: string
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

export type MeetingTranscriptSegment = {
  id: string
  organizationId: string
  meetingId: string
  transcriptId: string
  sequence: number
  speakerParticipantId: string | null
  speakerLabel: string
  startMs: number
  endMs: number
  text: string
  language: string | null
  confidence: number | null
  source: 'live_caption' | 'post_recording' | 'corrected'
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingTranscriptSegmentRevision = {
  id: string
  segmentId: string
  revision: number
  speakerParticipantId: string | null
  speakerLabel: string
  text: string
  editedBy: string
  createdAt: string
}

export type MeetingAgendaItem = {
  id: string
  organizationId: string
  meetingId: string
  sourceChannelId: string
  sourceMessageId: string
  body: string
  status: 'planned' | 'discussed' | 'dropped'
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type MeetingDecision = {
  id: string
  organizationId: string
  meetingId: string
  minutesId: string | null
  statement: string
  status: 'proposed' | 'confirmed' | 'superseded' | 'rejected'
  ownerUserId: string | null
  projectId: string | null
  ticketId: string | null
  evidenceSegmentId: string | null
  createdBy: 'ai' | 'user'
  reviewStatus: 'unreviewed' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingActionItem = {
  id: string
  organizationId: string
  meetingId: string
  minutesId: string | null
  task: string
  assigneeUserId: string | null
  assigneeLabel: string | null
  dueAt: string | null
  dueText: string | null
  priority: 'none' | 'urgent' | 'high' | 'medium' | 'low'
  status: 'proposed' | 'accepted' | 'in_progress' | 'completed' | 'cancelled'
  projectId: string | null
  ticketId: string | null
  workItemId: string | null
  evidenceSegmentId: string | null
  createdBy: 'ai' | 'user'
  reviewStatus: 'unreviewed' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}
