import { Buffer } from 'node:buffer'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type MeetingTranscriptSegmentSource = 'live_caption' | 'post_recording' | 'corrected'

export type MeetingTranscriptSegmentResource = {
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
  source: MeetingTranscriptSegmentSource
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingTranscriptSegmentRevisionResource = {
  id: string
  segmentId: string
  revision: number
  speakerParticipantId: string | null
  speakerLabel: string
  text: string
  editedBy: string
  createdAt: string
}

type SegmentRow = {
  id: string
  organization_id: string
  meeting_id: string
  transcript_id: string
  sequence: number
  speaker_participant_id: string | null
  speaker_label: string
  start_ms: number
  end_ms: number
  text: string
  language: string | null
  confidence: number | null
  source: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapSegment(row: SegmentRow): MeetingTranscriptSegmentResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    transcriptId: row.transcript_id,
    sequence: row.sequence,
    speakerParticipantId: row.speaker_participant_id,
    speakerLabel: row.speaker_label,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    language: row.language,
    confidence: row.confidence,
    source: row.source as MeetingTranscriptSegmentSource,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function milliseconds(record: Record<string, unknown>, millisecondKey: string, secondKey: string) {
  const direct = optionalNumber(record, millisecondKey)
  const seconds = optionalNumber(record, secondKey)
  return Math.max(0, Math.round(direct ?? (seconds ?? 0) * 1_000))
}

function normalizedSegment(
  raw: unknown,
  sequence: number,
  source: Exclude<MeetingTranscriptSegmentSource, 'corrected'>,
  defaultLanguage: string | null
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (!text) return null
  const startMs = milliseconds(record, 'start_ms', 'start')
  const endMs = Math.max(startMs, milliseconds(record, 'end_ms', 'end'))
  const speakerValue = record.speaker_label ?? record.speaker
  const speakerLabel =
    typeof speakerValue === 'string' && speakerValue.trim()
      ? speakerValue.trim()
      : `Speaker ${sequence + 1}`
  const participantValue = record.speaker_participant_id ?? record.speakerParticipantId
  const confidence = optionalNumber(record, 'confidence')
  const languageValue = record.language
  return {
    sequence,
    speakerParticipantId:
      typeof participantValue === 'string' && UUID_PATTERN.test(participantValue)
        ? participantValue
        : null,
    speakerLabel,
    startMs,
    endMs,
    text,
    language:
      typeof languageValue === 'string' && languageValue.trim()
        ? languageValue.trim()
        : defaultLanguage,
    confidence: confidence !== null && confidence >= 0 && confidence <= 1 ? confidence : null,
    source
  }
}

export async function persistMeetingTranscriptSegments(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    meetingId: string
    transcriptId: string
    segments: unknown
    source: Exclude<MeetingTranscriptSegmentSource, 'corrected'>
    language: string | null
  }
): Promise<number> {
  if (!Array.isArray(input.segments)) return 0
  const rows = input.segments
    .map((item, index) => normalizedSegment(item, index, input.source, input.language))
    .filter((item) => item !== null)
  if (rows.length === 0) return 0
  await trx
    .insertInto('meetings.transcript_segments')
    .values(
      rows.map((row) => ({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        transcript_id: input.transcriptId,
        sequence: row.sequence,
        speaker_participant_id: row.speakerParticipantId,
        speaker_label: row.speakerLabel,
        start_ms: row.startMs,
        end_ms: row.endMs,
        text: row.text,
        language: row.language,
        confidence: row.confidence,
        source: row.source
      }))
    )
    .onConflict((conflict) =>
      conflict.columns(['organization_id', 'transcript_id', 'sequence']).doNothing()
    )
    .execute()
  return rows.length
}

type SegmentCursor = { sequence: number; id: string }

function decodeCursor(cursor: string | null): SegmentCursor | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as SegmentCursor
    return Number.isInteger(parsed.sequence) && UUID_PATTERN.test(parsed.id) ? parsed : null
  } catch {
    return null
  }
}

function encodeCursor(item: MeetingTranscriptSegmentResource): string {
  return Buffer.from(JSON.stringify({ sequence: item.sequence, id: item.id })).toString('base64url')
}

export async function listMeetingTranscriptSegments(
  db: Kysely<Database>,
  input: {
    organizationId: string
    transcriptId: string
    cursor?: string | null
    limit?: number
    query?: string | null
  }
): Promise<{ items: MeetingTranscriptSegmentResource[]; nextCursor: string | null } | null> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const transcript = await trx
      .selectFrom('meetings.transcripts')
      .select('id')
      .where('id', '=', input.transcriptId)
      .executeTakeFirst()
    if (!transcript) return null
    const cursor = decodeCursor(input.cursor ?? null)
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, input.limit ?? DEFAULT_PAGE_SIZE))
    const query = input.query?.trim().slice(0, 100)
    let selection = trx
      .selectFrom('meetings.transcript_segments')
      .selectAll()
      .where('transcript_id', '=', input.transcriptId)
    if (cursor) {
      selection = selection.where((expression) =>
        expression.or([
          expression('sequence', '>', cursor.sequence),
          expression.and([
            expression('sequence', '=', cursor.sequence),
            expression('id', '>', cursor.id)
          ])
        ])
      )
    }
    if (query) selection = selection.where('text', 'ilike', `%${query}%`)
    const rows = await selection
      .orderBy('sequence')
      .orderBy('id')
      .limit(limit + 1)
      .execute()
    const items = rows.slice(0, limit).map(mapSegment)
    return {
      items,
      nextCursor: rows.length > limit && items.length > 0 ? encodeCursor(items.at(-1)!) : null
    }
  })
}

export async function getMeetingTranscriptSegment(
  db: Kysely<Database>,
  organizationId: string,
  segmentId: string
): Promise<MeetingTranscriptSegmentResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.transcript_segments')
      .selectAll()
      .where('id', '=', segmentId)
      .executeTakeFirst()
    return row ? mapSegment(row) : null
  })
}

export type CorrectMeetingTranscriptSegmentResult =
  | { ok: true; segment: MeetingTranscriptSegmentResource }
  | { ok: false; reason: 'not_found' | 'version_conflict' | 'empty_body' }

export async function correctMeetingTranscriptSegment(
  db: Kysely<Database>,
  input: {
    organizationId: string
    segmentId: string
    actorUserId: string
    expectedVersion: number
    speakerLabel: string
    speakerParticipantId?: string | null
    text: string
  }
): Promise<CorrectMeetingTranscriptSegmentResult> {
  const speakerLabel = input.speakerLabel.trim()
  const text = input.text.trim()
  if (!speakerLabel || !text) return { ok: false, reason: 'empty_body' }
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.transcript_segments')
      .selectAll()
      .where('id', '=', input.segmentId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict' }
    }
    if (
      current.speaker_label === speakerLabel &&
      current.text === text &&
      current.speaker_participant_id === (input.speakerParticipantId ?? null)
    ) {
      return { ok: true, segment: mapSegment(current) }
    }
    await trx
      .insertInto('meetings.transcript_segment_revisions')
      .values({
        organization_id: input.organizationId,
        segment_id: input.segmentId,
        revision: current.version,
        speaker_participant_id: current.speaker_participant_id,
        speaker_label: current.speaker_label,
        text: current.text,
        edited_by: input.actorUserId
      })
      .execute()
    const nextVersion = input.expectedVersion + 1
    const updated = await trx
      .updateTable('meetings.transcript_segments')
      .set({
        speaker_participant_id: input.speakerParticipantId ?? null,
        speaker_label: speakerLabel,
        text,
        source: 'corrected',
        version: nextVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.segmentId)
      .returningAll()
      .executeTakeFirstOrThrow()
    const transcript = await trx
      .updateTable('meetings.transcripts')
      .set({ version: sql`version + 1`, updated_at: sql`now()` })
      .where('id', '=', current.transcript_id)
      .returning('version')
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.transcript.segment_corrected',
      'meeting_transcript',
      current.transcript_id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_transcript',
      current.transcript_id,
      Number(transcript.version),
      'updated'
    )
    return { ok: true, segment: mapSegment(updated) }
  })
}

export async function listMeetingTranscriptSegmentRevisions(
  db: Kysely<Database>,
  organizationId: string,
  segmentId: string
): Promise<MeetingTranscriptSegmentRevisionResource[] | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const segment = await trx
      .selectFrom('meetings.transcript_segments')
      .select('id')
      .where('id', '=', segmentId)
      .executeTakeFirst()
    if (!segment) return null
    const rows = await trx
      .selectFrom('meetings.transcript_segment_revisions')
      .selectAll()
      .where('segment_id', '=', segmentId)
      .orderBy('revision', 'desc')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      segmentId: row.segment_id,
      revision: Number(row.revision),
      speakerParticipantId: row.speaker_participant_id,
      speakerLabel: row.speaker_label,
      text: row.text,
      editedBy: row.edited_by,
      createdAt: new Date(row.created_at).toISOString()
    }))
  })
}
