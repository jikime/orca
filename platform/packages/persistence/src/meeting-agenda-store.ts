import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

export type MeetingAgendaStatus = 'planned' | 'discussed' | 'dropped'

export type MeetingAgendaItemResource = {
  id: string
  organizationId: string
  meetingId: string
  sourceChannelId: string
  sourceMessageId: string
  body: string
  status: MeetingAgendaStatus
  createdBy: string
  createdAt: string
  updatedAt: string
}

type AgendaRow = {
  id: string
  organization_id: string
  meeting_id: string
  source_channel_id: string
  source_message_id: string
  body: string
  status: string
  created_by: string
  created_at: Date | string
  updated_at: Date | string
}

function mapAgendaItem(row: AgendaRow): MeetingAgendaItemResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    sourceChannelId: row.source_channel_id,
    sourceMessageId: row.source_message_id,
    body: row.body,
    status: row.status as MeetingAgendaStatus,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export async function listMeetingAgendaItems(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingAgendaItemResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.agenda_items')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapAgendaItem)
  })
}

export async function getMeetingAgendaItem(
  db: Kysely<Database>,
  organizationId: string,
  itemId: string
): Promise<MeetingAgendaItemResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.agenda_items')
      .selectAll()
      .where('id', '=', itemId)
      .executeTakeFirst()
    return row ? mapAgendaItem(row) : null
  })
}

async function sourceMessage(
  trx: Transaction<Database>,
  input: {
    actorUserId: string
    meetingId: string
    sourceChannelId: string
    sourceMessageId: string
  }
): Promise<{ body: string } | null> {
  const channel = await trx
    .selectFrom('collaboration.channels')
    .innerJoin('collaboration.channel_members', (join) =>
      join
        .onRef('collaboration.channel_members.channel_id', '=', 'collaboration.channels.id')
        .on('collaboration.channel_members.user_id', '=', input.actorUserId)
    )
    .select('collaboration.channels.id')
    .where('collaboration.channels.id', '=', input.sourceChannelId)
    .where('collaboration.channels.scope_type', '=', 'meeting')
    .where('collaboration.channels.scope_id', '=', input.meetingId)
    .executeTakeFirst()
  if (!channel) return null
  return (
    (await trx
      .selectFrom('collaboration.messages')
      .select('body')
      .where('id', '=', input.sourceMessageId)
      .where('channel_id', '=', input.sourceChannelId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()) ?? null
  )
}

export type CreateMeetingAgendaItemResult =
  | { ok: true; item: MeetingAgendaItemResource; created: boolean }
  | { ok: false; reason: 'meeting_not_found' | 'invalid_source_message' }

// The source text is read inside the tenant transaction so a client cannot
// replace a chat message with different agenda content during promotion.
export async function createMeetingAgendaItemFromMessage(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    meetingId: string
    sourceChannelId: string
    sourceMessageId: string
  }
): Promise<CreateMeetingAgendaItemResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const meeting = await trx
      .selectFrom('meetings.meetings')
      .select('id')
      .where('id', '=', input.meetingId)
      .executeTakeFirst()
    if (!meeting) return { ok: false, reason: 'meeting_not_found' }

    const existing = await trx
      .selectFrom('meetings.agenda_items')
      .selectAll()
      .where('meeting_id', '=', input.meetingId)
      .where('source_message_id', '=', input.sourceMessageId)
      .executeTakeFirst()
    if (existing) return { ok: true, item: mapAgendaItem(existing), created: false }

    const source = await sourceMessage(trx, input)
    const body = source?.body.trim().slice(0, 4000) ?? ''
    if (!body) return { ok: false, reason: 'invalid_source_message' }
    const row = await trx
      .insertInto('meetings.agenda_items')
      .values({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        source_channel_id: input.sourceChannelId,
        source_message_id: input.sourceMessageId,
        body,
        created_by: input.actorUserId
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'meeting_id', 'source_message_id']).doNothing()
      )
      .returningAll()
      .executeTakeFirst()
    if (!row) {
      const winner = await trx
        .selectFrom('meetings.agenda_items')
        .selectAll()
        .where('meeting_id', '=', input.meetingId)
        .where('source_message_id', '=', input.sourceMessageId)
        .executeTakeFirstOrThrow()
      return { ok: true, item: mapAgendaItem(winner), created: false }
    }
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.agenda_item.created',
      'meeting_agenda_item',
      row.id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_agenda_item',
      row.id,
      1,
      'created'
    )
    return { ok: true, item: mapAgendaItem(row), created: true }
  })
}
