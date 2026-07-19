import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction, withWorkerClaimTransaction } from './tenant-transaction'

export type MeetingProcessingJobType = 'transcribe' | 'summarize'
export type MeetingProcessingJobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export type MeetingProcessingJobResource = {
  id: string
  organizationId: string
  meetingId: string
  recordingId: string
  jobType: MeetingProcessingJobType
  status: MeetingProcessingJobStatus
  attempts: number
  lastError: string | null
  transcriptId: string | null
  minutesId: string | null
  createdAt: string
  updatedAt: string
}

export type ClaimedMeetingProcessingJob = MeetingProcessingJobResource & {
  workerId: string
  leasedUntil: string
}

type ProcessingJobRow = {
  id: string
  organization_id: string
  meeting_id: string
  recording_id: string
  job_type: string
  status: string
  attempts: number
  leased_until: Date | string | null
  worker_id: string | null
  last_error: string | null
  transcript_id: string | null
  minutes_id: string | null
  created_at: Date | string
  updated_at: Date | string
}

function mapJob(row: ProcessingJobRow): MeetingProcessingJobResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    jobType: row.job_type as MeetingProcessingJobType,
    status: row.status as MeetingProcessingJobStatus,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    transcriptId: row.transcript_id,
    minutesId: row.minutes_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export async function listMeetingProcessingJobs(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingProcessingJobResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.processing_jobs')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapJob)
  })
}

export async function claimMeetingProcessingJobs(
  db: Kysely<Database>,
  input: { workerId: string; batchSize: number; leaseMs: number }
): Promise<ClaimedMeetingProcessingJob[]> {
  return withWorkerClaimTransaction(db, async (trx) => {
    const due = await trx
      .selectFrom('meetings.processing_jobs')
      .select('id')
      .where((expression) =>
        expression.or([
          expression.and([
            expression('status', '=', 'queued'),
            expression('available_at', '<=', sql<Date>`now()`)
          ]),
          expression.and([
            expression('status', '=', 'processing'),
            expression('leased_until', '<=', sql<Date>`now()`)
          ])
        ])
      )
      .orderBy('available_at', 'asc')
      .orderBy('id', 'asc')
      .limit(input.batchSize)
      .forUpdate()
      .skipLocked()
      .execute()
    if (due.length === 0) return []
    const leasedUntil = new Date(Date.now() + input.leaseMs)
    const rows = await trx
      .updateTable('meetings.processing_jobs')
      .set({
        status: 'processing',
        attempts: sql`attempts + 1`,
        worker_id: input.workerId,
        leased_until: leasedUntil,
        updated_at: sql`now()`
      })
      .where(
        'id',
        'in',
        due.map((item) => item.id)
      )
      .returningAll()
      .execute()
    return rows.map((row) => ({
      ...mapJob(row),
      workerId: input.workerId,
      leasedUntil: leasedUntil.toISOString()
    }))
  })
}

export async function getMeetingProcessingTranscript(
  db: Kysely<Database>,
  organizationId: string,
  transcriptId: string
): Promise<{ content: string | null; segments: unknown; language: string | null } | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.transcripts')
      .select(['content', 'segments', 'language'])
      .where('id', '=', transcriptId)
      .executeTakeFirst()
    return row ?? null
  })
}

async function ownedProcessingJob(
  trx: Transaction<Database>,
  jobId: string,
  workerId: string
): Promise<ProcessingJobRow | null> {
  const row = await trx
    .selectFrom('meetings.processing_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .forUpdate()
    .executeTakeFirst()
  if (!row || row.status !== 'processing' || row.worker_id !== workerId) return null
  return row
}

export async function completeMeetingTranscriptionJob(
  db: Kysely<Database>,
  input: {
    organizationId: string
    jobId: string
    workerId: string
    content: string
    segments: unknown
    language: string | null
  }
): Promise<string | null> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const job = await ownedProcessingJob(trx, input.jobId, input.workerId)
    if (!job || job.job_type !== 'transcribe') return null
    const transcript = await trx
      .insertInto('meetings.transcripts')
      .values({
        organization_id: input.organizationId,
        meeting_id: job.meeting_id,
        content: input.content,
        segments: JSON.stringify(input.segments),
        source: 'post_recording',
        language: input.language
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.organizationId,
      'meeting.transcript.generated',
      'meeting_transcript',
      transcript.id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_transcript',
      transcript.id,
      1,
      'created'
    )
    await trx
      .updateTable('meetings.processing_jobs')
      .set({
        status: 'completed',
        transcript_id: transcript.id,
        leased_until: null,
        updated_at: sql`now()`
      })
      .where('id', '=', input.jobId)
      .execute()
    await trx
      .insertInto('meetings.processing_jobs')
      .values({
        organization_id: input.organizationId,
        meeting_id: job.meeting_id,
        recording_id: job.recording_id,
        job_type: 'summarize',
        transcript_id: transcript.id
      })
      .onConflict((conflict) =>
        conflict.columns(['organization_id', 'recording_id', 'job_type']).doNothing()
      )
      .execute()
    return transcript.id
  })
}

export async function completeMeetingSummarizationJob(
  db: Kysely<Database>,
  input: { organizationId: string; jobId: string; workerId: string; summary: string }
): Promise<string | null> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const job = await ownedProcessingJob(trx, input.jobId, input.workerId)
    if (!job || job.job_type !== 'summarize') return null
    const meeting = await trx
      .selectFrom('meetings.meetings')
      .select('host_user_id')
      .where('id', '=', job.meeting_id)
      .executeTakeFirst()
    if (!meeting) return null
    const minutes = await trx
      .insertInto('meetings.minutes')
      .values({
        organization_id: input.organizationId,
        meeting_id: job.meeting_id,
        summary: input.summary,
        source_type: 'ai',
        review_status: 'unreviewed',
        author_user_id: meeting.host_user_id
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('meetings.minute_revisions')
      .values({
        organization_id: input.organizationId,
        minutes_id: minutes.id,
        revision: 1,
        summary: input.summary,
        edited_by: meeting.host_user_id
      })
      .execute()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      meeting.host_user_id,
      'meeting.minutes.ai_generated',
      'meeting_minutes',
      minutes.id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_minutes',
      minutes.id,
      1,
      'created'
    )
    await trx
      .updateTable('meetings.processing_jobs')
      .set({
        status: 'completed',
        minutes_id: minutes.id,
        leased_until: null,
        updated_at: sql`now()`
      })
      .where('id', '=', input.jobId)
      .execute()
    return minutes.id
  })
}

export async function requeueMeetingProcessingJob(
  db: Kysely<Database>,
  input: {
    organizationId: string
    jobId: string
    workerId: string
    error: string
    retryAt: Date
    terminal: boolean
  }
): Promise<boolean> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const updated = await trx
      .updateTable('meetings.processing_jobs')
      .set({
        status: input.terminal ? 'failed' : 'queued',
        available_at: input.retryAt,
        leased_until: null,
        worker_id: null,
        last_error: input.error.slice(0, 2_000),
        updated_at: sql`now()`
      })
      .where('id', '=', input.jobId)
      .where('status', '=', 'processing')
      .where('worker_id', '=', input.workerId)
      .returning('id')
      .executeTakeFirst()
    return Boolean(updated)
  })
}
