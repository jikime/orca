import { type Kysely } from 'kysely'
import { auditAiEvent, emitAiResourceChange } from './ai-resource-events'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// ai.evaluations: APPEND-ONLY eval log (INSERT + SELECT only). A record is only ever 'created'; there
// is no update/delete route. subject_id is the OPAQUE id of what was evaluated (no FK).

export type AiEvalVerdict = 'pass' | 'warn' | 'fail'

export type AiEvaluationResource = {
  id: string
  organizationId: string
  subjectId: string | null
  modelKey: string
  metric: string
  score: number
  verdict: AiEvalVerdict
  notes: string | null
  evaluatedBy: string | null
  createdAt: string
}

type EvaluationRow = {
  id: string
  organization_id: string
  subject_id: string | null
  model_key: string
  metric: string
  score: string | number
  verdict: string
  notes: string | null
  evaluated_by: string | null
  created_at: Date | string
}

function mapEvaluation(row: EvaluationRow): AiEvaluationResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    subjectId: row.subject_id,
    modelKey: row.model_key,
    metric: row.metric,
    score: Number(row.score),
    verdict: row.verdict as AiEvalVerdict,
    notes: row.notes,
    evaluatedBy: row.evaluated_by,
    createdAt: new Date(row.created_at).toISOString()
  }
}

export type RecordAiEvaluationInput = {
  organizationId: string
  actorUserId: string
  subjectId?: string | null
  modelKey: string
  metric: string
  score: number
  verdict: AiEvalVerdict
  notes?: string | null
  evaluatedBy?: string | null
}

export async function recordAiEvaluation(
  db: Kysely<Database>,
  input: RecordAiEvaluationInput
): Promise<AiEvaluationResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('ai.evaluations')
      .values({
        organization_id: input.organizationId,
        subject_id: input.subjectId ?? null,
        model_key: input.modelKey,
        metric: input.metric,
        score: input.score,
        verdict: input.verdict,
        notes: input.notes ?? null,
        evaluated_by: input.evaluatedBy ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAiEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'ai.evaluation.recorded',
      'ai_evaluation',
      row.id
    )
    // Append-only: an evaluation is only ever 'created'.
    await emitAiResourceChange(trx, input.organizationId, 'ai_evaluation', row.id, 1, 'created')
    return mapEvaluation(row)
  })
}

export async function getAiEvaluation(
  db: Kysely<Database>,
  organizationId: string,
  evaluationId: string
): Promise<AiEvaluationResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('ai.evaluations')
      .selectAll()
      .where('id', '=', evaluationId)
      .executeTakeFirst()
    return row ? mapEvaluation(row) : null
  })
}

export type AiEvaluationPage = { items: AiEvaluationResource[]; nextCursor: string | null }

export async function listAiEvaluations(
  db: Kysely<Database>,
  organizationId: string,
  options: { limit?: number; cursor?: string | null; subjectId?: string } = {}
): Promise<AiEvaluationPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('ai.evaluations')
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
    return { items: page.map(mapEvaluation), nextCursor }
  })
}
