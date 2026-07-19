import { randomUUID } from 'node:crypto'
import type { ObjectStorage } from '@pie/object-storage-adapter'
import {
  addMeetingParticipant,
  applyMeetingEgressEnded,
  applyMeetingMediaPresenceEvent,
  attachMeetingRecordingMedia,
  createDatabase,
  createDatabasePool,
  createMeeting,
  listMeetingMinutes,
  listMeetingParticipants,
  listMeetingProcessingJobs,
  listMeetingTranscripts,
  runMigrations,
  seedOrganizationFixture,
  setMeetingParticipantConsent,
  startMeetingRecording,
  transitionMeeting,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MeetingAiClient } from './meeting-ai-client'
import { createMeetingProcessingLoop } from './meeting-processing-loop'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED meeting processing: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
}, 180_000)

afterAll(async () => {
  await db?.destroy()
  await harness?.stop()
})

describe('meeting recording processing loop', () => {
  it('turns one completed audio egress into a transcript and review-gated AI minutes', async (ctx) => {
    if (!harness) return ctx.skip()
    const organizationId = randomUUID()
    const userId = randomUUID()
    await seedOrganizationFixture(db, {
      id: organizationId,
      slug: `processing-${organizationId.slice(0, 8)}`,
      displayName: 'Processing'
    })
    const meeting = await createMeeting(db, {
      organizationId,
      actorUserId: userId,
      hostUserId: userId,
      title: 'Recorded review'
    })
    const live = await transitionMeeting(db, {
      organizationId,
      actorUserId: userId,
      meetingId: meeting.id,
      expectedVersion: meeting.version,
      toStatus: 'live'
    })
    expect(live.ok).toBe(true)
    const participant = await addMeetingParticipant(db, {
      organizationId,
      actorUserId: userId,
      meetingId: meeting.id,
      userId,
      role: 'host'
    })
    expect(participant.ok).toBe(true)
    await applyMeetingMediaPresenceEvent(db, {
      organizationId,
      eventId: randomUUID(),
      meetingId: meeting.id,
      participantUserId: userId,
      eventType: 'participant_joined',
      occurredAt: new Date().toISOString()
    })
    const joined = (await listMeetingParticipants(db, organizationId, meeting.id))[0]!
    await setMeetingParticipantConsent(db, {
      organizationId,
      actorUserId: userId,
      participantId: joined.id,
      expectedVersion: joined.version,
      consent: true
    })
    const started = await startMeetingRecording(db, {
      organizationId,
      actorUserId: userId,
      meetingId: meeting.id
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const audioEgressId = `audio-${randomUUID()}`
    await attachMeetingRecordingMedia(db, {
      organizationId,
      actorUserId: userId,
      recordingId: started.recording.id,
      expectedVersion: started.recording.version,
      videoEgressId: `video-${randomUUID()}`,
      audioEgressId,
      transcriptionDispatchId: null
    })
    await applyMeetingEgressEnded(db, {
      organizationId,
      meetingId: meeting.id,
      eventId: randomUUID(),
      egressId: audioEgressId,
      succeeded: true,
      durationSeconds: 60,
      errorCode: null,
      occurredAt: new Date().toISOString()
    })

    const storage: ObjectStorage = {
      presignPut: async () => '',
      presignGet: async () => '',
      head: async () => ({ exists: true, sizeBytes: 3, contentType: 'audio/mpeg' }),
      ensureBucket: async () => undefined,
      putObject: async () => undefined,
      getObjectBytes: async () => new Uint8Array([1, 2, 3])
    }
    const ai: MeetingAiClient = {
      transcribe: async () => ({
        text: 'We decided to ship. Mina owns the release.',
        segments: [{ speaker: 'A', start: 0, end: 2, text: 'We decided to ship.' }],
        language: 'en'
      }),
      draftMinutes: async () => ({
        summary: 'The team agreed to ship.',
        decisions: ['Ship the release.'],
        actionItems: [{ task: 'Prepare the release', owner: 'Mina', due: null }]
      })
    }
    const loop = createMeetingProcessingLoop({
      db,
      objectStorage: storage,
      ai,
      workerId: `worker-${randomUUID()}`,
      batchSize: 4,
      leaseMs: 60_000,
      pollIntervalMs: 1_000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0
    })
    expect((await loop.runOnce()).completed).toBe(1)
    expect((await loop.runOnce()).completed).toBe(1)

    const jobs = await listMeetingProcessingJobs(db, organizationId, meeting.id)
    expect(jobs.map((job) => [job.jobType, job.status])).toEqual([
      ['transcribe', 'completed'],
      ['summarize', 'completed']
    ])
    const transcripts = await listMeetingTranscripts(db, organizationId, meeting.id)
    expect(transcripts).toHaveLength(1)
    expect(transcripts[0]?.source).toBe('post_recording')
    const minutes = await listMeetingMinutes(db, organizationId, meeting.id)
    expect(minutes).toHaveLength(1)
    expect(minutes[0]).toMatchObject({ sourceType: 'ai', reviewStatus: 'unreviewed' })
    expect(minutes[0]?.summary).toContain('## 결정 사항')
    expect(minutes[0]?.summary).toContain('Mina')
  })
})
