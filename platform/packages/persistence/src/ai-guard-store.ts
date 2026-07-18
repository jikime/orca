import { type Kysely } from 'kysely'
import { auditAiEvent, emitAiResourceChange } from './ai-resource-events'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// ai.guard_events: APPEND-ONLY prompt-injection / safety guard log (evidence). INSERT + SELECT only; a
// guard event is only ever 'created' — there is no update/delete route (it is tamper-evident evidence).

export type AiGuardKind = 'prompt_injection' | 'jailbreak' | 'pii' | 'secret' | 'toxicity'
export type AiGuardAction = 'blocked' | 'flagged' | 'allowed'

export type AiGuardEventResource = {
  id: string
  organizationId: string
  subjectId: string | null
  guardKind: AiGuardKind
  action: AiGuardAction
  detail: string
  detectedBy: string
  createdAt: string
}

type GuardEventRow = {
  id: string
  organization_id: string
  subject_id: string | null
  guard_kind: string
  action: string
  detail: string
  detected_by: string
  created_at: Date | string
}

function mapGuardEvent(row: GuardEventRow): AiGuardEventResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    subjectId: row.subject_id,
    guardKind: row.guard_kind as AiGuardKind,
    action: row.action as AiGuardAction,
    detail: row.detail,
    detectedBy: row.detected_by,
    createdAt: new Date(row.created_at).toISOString()
  }
}

export type RecordAiGuardEventInput = {
  organizationId: string
  actorUserId: string
  subjectId?: string | null
  guardKind: AiGuardKind
  action: AiGuardAction
  detail: string
  detectedBy: string
}

export async function recordAiGuardEvent(
  db: Kysely<Database>,
  input: RecordAiGuardEventInput
): Promise<AiGuardEventResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('ai.guard_events')
      .values({
        organization_id: input.organizationId,
        subject_id: input.subjectId ?? null,
        guard_kind: input.guardKind,
        action: input.action,
        detail: input.detail,
        detected_by: input.detectedBy
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAiEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'ai.guard_event.recorded',
      'ai_guard_event',
      row.id
    )
    // Append-only: a guard event is only ever 'created'.
    await emitAiResourceChange(trx, input.organizationId, 'ai_guard_event', row.id, 1, 'created')
    return mapGuardEvent(row)
  })
}

export async function getAiGuardEvent(
  db: Kysely<Database>,
  organizationId: string,
  guardEventId: string
): Promise<AiGuardEventResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('ai.guard_events')
      .selectAll()
      .where('id', '=', guardEventId)
      .executeTakeFirst()
    return row ? mapGuardEvent(row) : null
  })
}

export type AiGuardEventPage = { items: AiGuardEventResource[]; nextCursor: string | null }

export async function listAiGuardEvents(
  db: Kysely<Database>,
  organizationId: string,
  options: { limit?: number; cursor?: string | null; subjectId?: string } = {}
): Promise<AiGuardEventPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('ai.guard_events')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    if (options.subjectId !== undefined) {
      query = query.where('subject_id', '=', options.subjectId)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapGuardEvent), nextCursor }
  })
}
