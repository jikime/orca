import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

export type WorkItemSourceBinding = {
  kind: 'chat_message' | 'meeting_action_item'
  sourceId: string
  containerId: string
  containerLabel: string
  createdAt: string
}

export async function listWorkItemSourceBindings(
  db: Kysely<Database>,
  input: {
    organizationId: string
    workItemId: string
    userId: string | null
    includeChat: boolean
    includeMeetings: boolean
  }
): Promise<WorkItemSourceBinding[]> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const bindings: WorkItemSourceBinding[] = []
    const userId = input.userId
    if (input.includeChat && userId) {
      const rows = await trx
        .selectFrom('collaboration.message_work_item_links as link')
        .innerJoin('collaboration.messages as message', 'message.id', 'link.message_id')
        .innerJoin('collaboration.channels as channel', 'channel.id', 'message.channel_id')
        .innerJoin('collaboration.channel_members as member', (join) =>
          join.onRef('member.channel_id', '=', 'channel.id').on('member.user_id', '=', userId)
        )
        .select([
          'message.id as sourceId',
          'channel.id as containerId',
          'channel.name as containerLabel',
          'link.created_at as createdAt'
        ])
        .where('link.work_item_id', '=', input.workItemId)
        .execute()
      bindings.push(
        ...rows.map((row) => ({
          kind: 'chat_message' as const,
          sourceId: row.sourceId,
          containerId: row.containerId,
          containerLabel: row.containerLabel,
          createdAt: new Date(row.createdAt).toISOString()
        }))
      )
    }
    if (input.includeMeetings) {
      const rows = await trx
        .selectFrom('meetings.action_items as action')
        .innerJoin('meetings.meetings as meeting', 'meeting.id', 'action.meeting_id')
        .select([
          'action.id as sourceId',
          'meeting.id as containerId',
          'meeting.title as containerLabel',
          'action.created_at as createdAt'
        ])
        .where('action.work_item_id', '=', input.workItemId)
        .execute()
      bindings.push(
        ...rows.map((row) => ({
          kind: 'meeting_action_item' as const,
          sourceId: row.sourceId,
          containerId: row.containerId,
          containerLabel: row.containerLabel,
          createdAt: new Date(row.createdAt).toISOString()
        }))
      )
    }
    return bindings.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
  })
}
