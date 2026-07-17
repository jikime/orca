import type { Transaction } from 'kysely'
import type { Database } from './database-schema'

// R5 slice 1: fold one append-only event into its projected turn (doc 19 :235-236, CAP-004).
// A streaming event with a turnId makes/updates a PROVISIONAL turn. A confirmed content hash
// finalizes it to an IMMUTABLE revision — but ONLY from an `observed`/`verified` event, never
// `declared` (doc 19 :218-220: declared/inferred is never evidence of completion). Once a turn
// is finalized its content_hash is never overwritten; later events only extend its position.

export type ProjectableEvent = {
  turnId: string | null
  streamId: string
  sequence: number
  occurredAt: string
  assertion: 'observed' | 'declared' | 'verified'
  contentHash: string | null
}

/** True when this event may finalize a turn: it confirms a content hash AND it is a
 *  first-hand observation (`observed`/`verified`). `declared` is intentionally excluded. */
function finalizes(event: ProjectableEvent): boolean {
  return (
    event.contentHash !== null && (event.assertion === 'observed' || event.assertion === 'verified')
  )
}

/**
 * Applies one event to its turn, returning whether the turn transitioned to `finalized` in
 * THIS call (so the caller can emit an agent_turn invalidation only on an actual finalize).
 * Called inside the ingest tenant tx after the event row is inserted.
 */
export async function projectTurnFromEvent(
  trx: Transaction<Database>,
  organizationId: string,
  agentSessionId: string,
  event: ProjectableEvent
): Promise<{ finalized: boolean }> {
  if (event.turnId === null) {
    // An event with no turnId is not part of a turn (e.g. a session-level lifecycle event).
    return { finalized: false }
  }
  const existing = await trx
    .selectFrom('execution.agent_turns')
    .selectAll()
    .where('agent_session_id', '=', agentSessionId)
    .where('turn_id', '=', event.turnId)
    .forUpdate()
    .executeTakeFirst()
  const willFinalize = finalizes(event)

  if (!existing) {
    await trx
      .insertInto('execution.agent_turns')
      .values({
        organization_id: organizationId,
        agent_session_id: agentSessionId,
        turn_id: event.turnId,
        status: willFinalize ? 'finalized' : 'provisional',
        content_hash: willFinalize ? event.contentHash : null,
        first_sequence: event.sequence,
        last_sequence: event.sequence,
        first_stream_id: event.streamId,
        revision: willFinalize ? 1 : 0,
        event_count: 1,
        first_event_at: event.occurredAt,
        last_event_at: event.occurredAt
      })
      .execute()
    return { finalized: willFinalize }
  }

  const alreadyFinalized = existing.status === 'finalized'
  const firstSequence = Math.min(Number(existing.first_sequence), event.sequence)
  const lastSequence = Math.max(Number(existing.last_sequence), event.sequence)
  const lastEventAt =
    new Date(event.occurredAt) > new Date(existing.last_event_at as string | Date)
      ? event.occurredAt
      : (existing.last_event_at as string | Date)
  // A finalize transition happens only once: provisional → finalized. An already-finalized
  // turn's content_hash is immutable — later events only extend first/last position.
  const transition = willFinalize && !alreadyFinalized
  await trx
    .updateTable('execution.agent_turns')
    .set({
      first_sequence: firstSequence,
      last_sequence: lastSequence,
      last_event_at: lastEventAt,
      event_count: existing.event_count + 1,
      ...(transition
        ? { status: 'finalized', content_hash: event.contentHash, revision: existing.revision + 1 }
        : {}),
      updated_at: new Date()
    })
    .where('id', '=', existing.id)
    .execute()
  return { finalized: transition }
}
