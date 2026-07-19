import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

export type MeetingMediaPresenceEvent = {
  organizationId: string
  eventId: string
  meetingId: string
  participantUserId: string
  eventType: 'participant_joined' | 'participant_left'
  occurredAt: string
}

export type ApplyMeetingMediaPresenceResult =
  | { outcome: 'updated'; participantId: string }
  | { outcome: 'duplicate' | 'stale' | 'participant_not_found' }

export async function applyMeetingMediaPresenceEvent(
  db: Kysely<Database>,
  input: MeetingMediaPresenceEvent
): Promise<ApplyMeetingMediaPresenceResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const delivery = await trx
      .insertInto('meetings.media_events')
      .values({
        organization_id: input.organizationId,
        event_id: input.eventId,
        meeting_id: input.meetingId,
        event_type: input.eventType,
        occurred_at: input.occurredAt
      })
      .onConflict((conflict) => conflict.columns(['organization_id', 'event_id']).doNothing())
      .returning('event_id')
      .executeTakeFirst()
    if (!delivery) return { outcome: 'duplicate' }

    const participant = await trx
      .selectFrom('meetings.participants')
      .selectAll()
      .where('meeting_id', '=', input.meetingId)
      .where('user_id', '=', input.participantUserId)
      .forUpdate()
      .executeTakeFirst()
    if (!participant) return { outcome: 'participant_not_found' }

    const observedAt = participant.presence_observed_at
      ? new Date(participant.presence_observed_at).getTime()
      : Number.NEGATIVE_INFINITY
    if (new Date(input.occurredAt).getTime() <= observedAt) return { outcome: 'stale' }

    const version = Number(participant.version) + 1
    const updated = await trx
      .updateTable('meetings.participants')
      .set({
        ...(input.eventType === 'participant_joined'
          ? { joined_at: input.occurredAt, left_at: null }
          : { left_at: input.occurredAt }),
        presence_observed_at: input.occurredAt,
        version,
        updated_at: sql`now()`
      })
      .where('id', '=', participant.id)
      .returning('id')
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.participantUserId,
      `meeting.${input.eventType}`,
      'meeting_participant',
      updated.id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_participant',
      updated.id,
      version,
      'updated'
    )
    return { outcome: 'updated', participantId: updated.id }
  })
}
