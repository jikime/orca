import { type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R7 MEETINGS — transcripts (captions). content OR segments carries the text; source records
// provenance (live_caption from the media plane's live caption, post_recording, or ai). The live media
// that PRODUCES the text is infra; this store persists the resulting transcript metadata only.

export type TranscriptSource = 'live_caption' | 'post_recording' | 'ai'

export type MeetingTranscriptResource = {
  id: string
  organizationId: string
  meetingId: string
  content: string | null
  segments: unknown | null
  source: TranscriptSource
  language: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type TranscriptRow = {
  id: string
  organization_id: string
  meeting_id: string
  content: string | null
  segments: unknown
  source: string
  language: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapTranscript(row: TranscriptRow): MeetingTranscriptResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    content: row.content,
    segments: row.segments ?? null,
    source: row.source as TranscriptSource,
    language: row.language,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

async function meetingExists(trx: Transaction<Database>, meetingId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('meetings.meetings')
    .select('id')
    .where('id', '=', meetingId)
    .executeTakeFirst()
  return Boolean(row)
}

export type CreateTranscriptResult =
  | { ok: true; transcript: MeetingTranscriptResource }
  | { ok: false; reason: 'meeting_not_found' }
  | { ok: false; reason: 'empty_body' }

export type CreateTranscriptInput = {
  organizationId: string
  actorUserId: string
  meetingId: string
  source: TranscriptSource
  content?: string | null
  segments?: unknown
  language?: string | null
}

/** Persists a transcript for a meeting. Requires at least one of content / segments. */
export async function createMeetingTranscript(
  db: Kysely<Database>,
  input: CreateTranscriptInput
): Promise<CreateTranscriptResult> {
  const hasContent = input.content !== undefined && input.content !== null && input.content !== ''
  const hasSegments = input.segments !== undefined && input.segments !== null
  if (!hasContent && !hasSegments) {
    return { ok: false, reason: 'empty_body' }
  }
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    if (!(await meetingExists(trx, input.meetingId))) {
      return { ok: false, reason: 'meeting_not_found' }
    }
    const row = await trx
      .insertInto('meetings.transcripts')
      .values({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        content: hasContent ? (input.content ?? null) : null,
        segments: hasSegments ? JSON.stringify(input.segments) : null,
        source: input.source,
        language: input.language ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.transcript.created',
      'meeting_transcript',
      row.id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_transcript',
      row.id,
      1,
      'created'
    )
    return { ok: true, transcript: mapTranscript(row) }
  })
}

export async function listMeetingTranscripts(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingTranscriptResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.transcripts')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapTranscript)
  })
}
