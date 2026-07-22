import { randomUUID } from 'node:crypto'
import type { ObjectStorage } from '@pie/object-storage-adapter'
import {
  addMeetingParticipant,
  applyMeetingMediaPresenceEvent,
  createDatabase,
  createDatabasePool,
  createMeeting,
  getMeetingGovernance,
  listMeetingGovernanceAudit,
  listMeetingRecordings,
  markMeetingRecordingStopped,
  requestMeetingDeletion,
  runMigrations,
  seedOrganizationFixture,
  setMeetingParticipantConsent,
  startMeetingRecording,
  transitionMeeting,
  updateMeetingGovernance,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMeetingRetentionDeletionLoop } from './meeting-retention-deletion-loop'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED meeting retention deletion: Docker unavailable — ${String(error)}`)
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

describe('meeting retention deletion loop', () => {
  it('deletes meeting media and derived records while preserving governance evidence', async (ctx) => {
    if (!harness) return ctx.skip()
    const organizationId = randomUUID()
    const userId = randomUUID()
    await seedOrganizationFixture(db, {
      id: organizationId,
      slug: `retention-${organizationId.slice(0, 8)}`,
      displayName: 'Retention'
    })
    const meeting = await createMeeting(db, {
      organizationId,
      actorUserId: userId,
      hostUserId: userId,
      title: 'Retention review'
    })
    const live = await transitionMeeting(db, {
      organizationId,
      actorUserId: userId,
      meetingId: meeting.id,
      expectedVersion: meeting.version,
      toStatus: 'live'
    })
    expect(live.ok).toBe(true)
    if (!live.ok) return
    const added = await addMeetingParticipant(db, {
      organizationId,
      actorUserId: userId,
      meetingId: meeting.id,
      userId,
      role: 'host'
    })
    expect(added.ok).toBe(true)
    await applyMeetingMediaPresenceEvent(db, {
      organizationId,
      eventId: randomUUID(),
      meetingId: meeting.id,
      participantUserId: userId,
      eventType: 'participant_joined',
      occurredAt: new Date().toISOString()
    })
    if (!added.ok) return
    const consented = await setMeetingParticipantConsent(db, {
      organizationId,
      actorUserId: userId,
      participantId: added.participant.id,
      expectedVersion: added.participant.version + 1,
      consent: true
    })
    expect(consented.ok).toBe(true)
    const recording = await startMeetingRecording(db, {
      organizationId,
      actorUserId: userId,
      meetingId: meeting.id
    })
    expect(recording.ok).toBe(true)
    if (!recording.ok) return
    await markMeetingRecordingStopped(db, {
      organizationId,
      actorUserId: userId,
      recordingId: recording.recording.id
    })
    const ended = await transitionMeeting(db, {
      organizationId,
      actorUserId: userId,
      meetingId: meeting.id,
      expectedVersion: live.meeting.version,
      toStatus: 'ended'
    })
    expect(ended.ok).toBe(true)
    const governance = await getMeetingGovernance(db, organizationId, meeting.id)
    expect(governance).not.toBeNull()
    if (!governance) return
    const requested = await requestMeetingDeletion(db, {
      organizationId,
      actorUserId: userId,
      meetingId: meeting.id,
      expectedVersion: governance.version,
      reason: 'integration test cleanup'
    })
    expect(requested.ok).toBe(true)

    const deletedKeys: string[] = []
    const storage: ObjectStorage = {
      presignPut: async () => '',
      presignGet: async () => '',
      head: async () => ({ exists: false }),
      ensureBucket: async () => undefined,
      putObject: async () => undefined,
      getObjectBytes: async () => new Uint8Array(),
      deleteObject: async (key) => {
        deletedKeys.push(key)
      }
    }
    const loop = createMeetingRetentionDeletionLoop({
      db,
      objectStorage: storage,
      workerId: `retention-worker-${randomUUID()}`,
      batchSize: 4,
      leaseMs: 60_000,
      pollIntervalMs: 1_000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0
    })
    expect(await loop.runOnce()).toEqual({ claimed: 1, completed: 1, requeued: 0, failed: 0 })
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        `org/${organizationId}/recordings/${recording.recording.id}.mp4`,
        `org/${organizationId}/transcripts/${recording.recording.id}.mp3`
      ])
    )
    expect(await listMeetingRecordings(db, organizationId, meeting.id)).toEqual([])
    expect(await getMeetingGovernance(db, organizationId, meeting.id)).toMatchObject({
      deletionStatus: 'completed',
      captureStatus: 'stopped'
    })
    expect(
      (await listMeetingGovernanceAudit(db, organizationId, meeting.id)).map((item) => item.action)
    ).toEqual(expect.arrayContaining(['meeting.deletion.requested', 'meeting.deletion.completed']))
  })

  it('blocks deletion while legal hold is active', async (ctx) => {
    if (!harness) return ctx.skip()
    const organizationId = randomUUID()
    const userId = randomUUID()
    await seedOrganizationFixture(db, {
      id: organizationId,
      slug: `legal-hold-${organizationId.slice(0, 8)}`,
      displayName: 'Legal Hold'
    })
    const meeting = await createMeeting(db, {
      organizationId,
      actorUserId: userId,
      hostUserId: userId,
      title: 'Held meeting'
    })
    const governance = await getMeetingGovernance(db, organizationId, meeting.id)
    expect(governance).not.toBeNull()
    if (!governance) return
    const held = await updateMeetingGovernance(db, {
      organizationId,
      actorUserId: userId,
      meetingId: meeting.id,
      expectedVersion: governance.version,
      legalHold: true
    })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    expect(
      await requestMeetingDeletion(db, {
        organizationId,
        actorUserId: userId,
        meetingId: meeting.id,
        expectedVersion: held.governance.version,
        reason: 'must not delete'
      })
    ).toEqual({ ok: false, reason: 'legal_hold' })
  })
})
