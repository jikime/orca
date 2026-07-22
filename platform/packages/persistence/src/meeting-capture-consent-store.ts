import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

export const MEETING_CAPTURE_TYPES = [
  'recording',
  'transcription',
  'ai_notes',
  'presentation_screenshot'
] as const

export const MEETING_CORE_CAPTURE_TYPES = ['recording', 'transcription', 'ai_notes'] as const

export type MeetingCaptureType = (typeof MEETING_CAPTURE_TYPES)[number]
export type MeetingCaptureConsentStatus = 'pending' | 'granted' | 'denied' | 'revoked'

export type MeetingCaptureConsentResource = {
  id: string
  organizationId: string
  meetingId: string
  participantId: string
  captureType: MeetingCaptureType
  policyVersion: number
  purpose: string
  status: MeetingCaptureConsentStatus
  currentPolicy: boolean
  grantedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type CaptureConsentRow = {
  id: string
  organization_id: string
  meeting_id: string
  participant_id: string
  capture_type: string
  policy_version: string | number
  purpose: string
  status: string
  granted_at: Date | string | null
  revoked_at: Date | string | null
  expires_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function isoOrNull(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null
}

function mapConsent(
  row: CaptureConsentRow,
  currentPolicyVersion: number
): MeetingCaptureConsentResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    participantId: row.participant_id,
    captureType: row.capture_type as MeetingCaptureType,
    policyVersion: Number(row.policy_version),
    purpose: row.purpose,
    status: row.status as MeetingCaptureConsentStatus,
    currentPolicy: Number(row.policy_version) === currentPolicyVersion,
    grantedAt: isoOrNull(row.granted_at),
    revokedAt: isoOrNull(row.revoked_at),
    expiresAt: isoOrNull(row.expires_at),
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export async function insertPendingMeetingCaptureConsents(
  trx: Transaction<Database>,
  input: { organizationId: string; meetingId: string; participantId: string }
): Promise<void> {
  const governance = await trx
    .selectFrom('meetings.governance')
    .select(['policy_version', 'purpose'])
    .where('meeting_id', '=', input.meetingId)
    .executeTakeFirstOrThrow()
  await trx
    .insertInto('meetings.capture_consents')
    .values(
      MEETING_CAPTURE_TYPES.map((captureType) => ({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        participant_id: input.participantId,
        capture_type: captureType,
        policy_version: governance.policy_version,
        purpose: governance.purpose,
        status: 'pending'
      }))
    )
    .onConflict((conflict) =>
      conflict
        .columns(['organization_id', 'meeting_id', 'participant_id', 'capture_type'])
        .doNothing()
    )
    .execute()
}

export async function listMeetingCaptureConsents(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingCaptureConsentResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const governance = await trx
      .selectFrom('meetings.governance')
      .select('policy_version')
      .where('meeting_id', '=', meetingId)
      .executeTakeFirst()
    if (!governance) return []
    const rows = await trx
      .selectFrom('meetings.capture_consents')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('participant_id')
      .orderBy('capture_type')
      .execute()
    return rows.map((row) => mapConsent(row, Number(governance.policy_version)))
  })
}

export type SetMeetingCaptureConsentResult =
  | { ok: true; consent: MeetingCaptureConsentResource }
  | { ok: false; reason: 'not_found' | 'participant_user_mismatch' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export async function setMeetingCaptureConsent(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    consentId: string
    expectedVersion: number
    status: Exclude<MeetingCaptureConsentStatus, 'pending'>
    expiresAt?: string | null
  }
): Promise<SetMeetingCaptureConsentResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.capture_consents')
      .innerJoin(
        'meetings.participants',
        'meetings.participants.id',
        'meetings.capture_consents.participant_id'
      )
      .selectAll('meetings.capture_consents')
      .select('meetings.participants.user_id')
      .where('meetings.capture_consents.id', '=', input.consentId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (current.user_id !== input.actorUserId) {
      // Capture consent is personal; a meeting manager cannot grant it for another participant.
      return { ok: false, reason: 'participant_user_mismatch' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const governance = await trx
      .selectFrom('meetings.governance')
      .select(['policy_version', 'purpose'])
      .where('meeting_id', '=', current.meeting_id)
      .executeTakeFirstOrThrow()
    const now = new Date()
    const version = currentVersion + 1
    const updated = await trx
      .updateTable('meetings.capture_consents')
      .set({
        status: input.status,
        policy_version: governance.policy_version,
        purpose: governance.purpose,
        granted_at: input.status === 'granted' ? now : null,
        revoked_at: input.status === 'revoked' ? now : null,
        expires_at: input.status === 'granted' ? (input.expiresAt ?? null) : null,
        version,
        updated_at: now
      })
      .where('id', '=', input.consentId)
      .returningAll()
      .executeTakeFirstOrThrow()
    if (updated.capture_type === 'recording') {
      await trx
        .updateTable('meetings.participants')
        .set({
          consent_recording: input.status === 'granted',
          version: sql`version + 1`,
          updated_at: now
        })
        .where('id', '=', updated.participant_id)
        .execute()
    }
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `meeting.capture_consent.${input.status}`,
      'meeting_capture_consent',
      input.consentId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_capture_consent',
      input.consentId,
      version,
      'updated'
    )
    return {
      ok: true,
      consent: mapConsent(updated, Number(governance.policy_version))
    }
  })
}

export async function setLegacyMeetingCaptureConsentSet(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    meetingId: string
    participantId: string
    actorUserId: string
    granted: boolean
  }
): Promise<void> {
  const governance = await trx
    .selectFrom('meetings.governance')
    .select(['policy_version', 'purpose'])
    .where('meeting_id', '=', input.meetingId)
    .executeTakeFirstOrThrow()
  const now = new Date()
  const rows = await trx
    .updateTable('meetings.capture_consents')
    .set({
      status: input.granted ? 'granted' : 'revoked',
      policy_version: governance.policy_version,
      purpose: governance.purpose,
      granted_at: input.granted ? now : null,
      revoked_at: input.granted ? null : now,
      expires_at: null,
      version: sql`version + 1`,
      updated_at: now
    })
    .where('meeting_id', '=', input.meetingId)
    .where('participant_id', '=', input.participantId)
    .where('capture_type', 'in', [...MEETING_CORE_CAPTURE_TYPES])
    .returning(['id', 'version'])
    .execute()
  for (const row of rows) {
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `meeting.capture_consent.${input.granted ? 'granted' : 'revoked'}`,
      'meeting_capture_consent',
      row.id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_capture_consent',
      row.id,
      Number(row.version),
      'updated'
    )
  }
}

export async function resetMeetingCaptureConsentsForParticipant(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    meetingId: string
    participantId: string
    actorUserId: string
  }
): Promise<void> {
  const governance = await trx
    .selectFrom('meetings.governance')
    .select(['policy_version', 'purpose'])
    .where('meeting_id', '=', input.meetingId)
    .executeTakeFirstOrThrow()
  const rows = await trx
    .updateTable('meetings.capture_consents')
    .set({
      status: 'pending',
      policy_version: governance.policy_version,
      purpose: governance.purpose,
      granted_at: null,
      revoked_at: null,
      expires_at: null,
      version: sql`version + 1`,
      updated_at: sql`now()`
    })
    .where('participant_id', '=', input.participantId)
    .returning(['id', 'version'])
    .execute()
  for (const row of rows) {
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_capture_consent',
      row.id,
      Number(row.version),
      'updated'
    )
  }
  await auditMeetingEvent(
    trx,
    input.organizationId,
    input.actorUserId,
    'meeting.capture_consent.reset_on_reinvite',
    'meeting_participant',
    input.participantId
  )
}

export async function meetingCaptureConsentReady(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string,
  captureTypes: readonly MeetingCaptureType[]
): Promise<boolean> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const governance = await trx
      .selectFrom('meetings.governance')
      .select('policy_version')
      .where('meeting_id', '=', meetingId)
      .executeTakeFirst()
    if (!governance) return false
    const joined = await trx
      .selectFrom('meetings.participants')
      .select('id')
      .where('meeting_id', '=', meetingId)
      .where('joined_at', 'is not', null)
      .where('left_at', 'is', null)
      .execute()
    if (joined.length === 0) return false
    const participantIds = joined.map((participant) => participant.id)
    const consents = await trx
      .selectFrom('meetings.capture_consents')
      .select(['participant_id', 'capture_type'])
      .where('meeting_id', '=', meetingId)
      .where('participant_id', 'in', participantIds)
      .where('capture_type', 'in', [...captureTypes])
      .where('policy_version', '=', governance.policy_version)
      .where('status', '=', 'granted')
      .where((expression) =>
        expression.or([
          expression('expires_at', 'is', null),
          expression('expires_at', '>', sql<Date>`now()`)
        ])
      )
      .execute()
    return consents.length === participantIds.length * captureTypes.length
  })
}

export async function meetingParticipantCaptureConsentReady(
  db: Kysely<Database>,
  input: {
    organizationId: string
    meetingId: string
    participantId: string
    captureTypes: readonly MeetingCaptureType[]
  }
): Promise<boolean> {
  if (input.captureTypes.length === 0) return false
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const governance = await trx
      .selectFrom('meetings.governance')
      .select('policy_version')
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst()
    if (!governance) return false
    const rows = await trx
      .selectFrom('meetings.capture_consents')
      .select('capture_type')
      .where('meeting_id', '=', input.meetingId)
      .where('participant_id', '=', input.participantId)
      .where('capture_type', 'in', [...input.captureTypes])
      .where('policy_version', '=', governance.policy_version)
      .where('status', '=', 'granted')
      .where((expression) =>
        expression.or([
          expression('expires_at', 'is', null),
          expression('expires_at', '>', sql<Date>`now()`)
        ])
      )
      .execute()
    return new Set(rows.map((row) => row.capture_type)).size === input.captureTypes.length
  })
}
