import type { Kysely } from 'kysely'
import { loadAgentSessionTx, type AgentSession } from './agent-session-store'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// R5 slice 1: the session/turn timeline projection read (doc 19). Turns are the folded
// projection; events are the append-only log ordered WITHIN a stream by sequence (never a
// cross-host global order from client time). assertion + trustDomain are surfaced so a
// caller can never silently treat a `declared`/`client_observed` event as server-verified.

export type AgentTurnView = {
  id: string
  turnId: string
  status: 'provisional' | 'finalized'
  contentHash: string | null
  revision: number
  firstSequence: number
  lastSequence: number
  eventCount: number
  firstEventAt: string
  lastEventAt: string
}

export type AgentTimelineEventView = {
  id: string
  eventId: string
  streamId: string
  sequence: number
  type: string
  producerType: string
  provider: string
  assertion: 'observed' | 'declared' | 'verified'
  trustDomain: 'client_observed' | 'provider_asserted' | 'server_verified'
  classification: string
  visibility: string
  turnId: string | null
  agentRunId: string | null
  contentHash: string | null
  occurredAt: string
  capturedAt: string
  receivedAt: string
}

export type AgentSessionTimeline = {
  session: AgentSession
  turns: AgentTurnView[]
  events: AgentTimelineEventView[]
  nextCursor: string | null
}

const CURSOR_SEPARATOR = '|'

function encodeCursor(streamId: string, sequence: number, id: string): string {
  return Buffer.from(`${streamId}${CURSOR_SEPARATOR}${sequence}${CURSOR_SEPARATOR}${id}`).toString(
    'base64url'
  )
}

function decodeCursor(cursor: string): { streamId: string; sequence: number; id: string } | null {
  const [streamId, rawSequence, id] = Buffer.from(cursor, 'base64url')
    .toString('utf-8')
    .split(CURSOR_SEPARATOR)
  if (streamId === undefined || rawSequence === undefined || id === undefined) {
    return null
  }
  const sequence = Number(rawSequence)
  if (!Number.isSafeInteger(sequence)) {
    return null
  }
  return { streamId, sequence, id }
}

/**
 * Reads a session's projected timeline: its turns (by opening sequence) and its events, paged
 * by an opaque cursor. Events are ordered (stream_id, sequence, id) so each stream is in its
 * own sequence order. Returns null if the session is not visible in this org (RLS-scoped).
 */
export async function listSessionTimeline(
  db: Kysely<Database>,
  organizationId: string,
  sessionId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<AgentSessionTimeline | null> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)
  const cursor = options.cursor ? decodeCursor(options.cursor) : null
  return withTenantTransaction(db, organizationId, async (trx) => {
    const session = await loadAgentSessionTx(trx, sessionId)
    if (!session) {
      return null
    }
    const turnRows = await trx
      .selectFrom('execution.agent_turns')
      .selectAll()
      .where('agent_session_id', '=', sessionId)
      .orderBy('first_sequence', 'asc')
      .orderBy('id', 'asc')
      .execute()

    let eventQuery = trx
      .selectFrom('execution.agent_events')
      .selectAll()
      .where('agent_session_id', '=', sessionId)
    if (cursor) {
      // Keyset page over the (stream_id, sequence, id) order.
      eventQuery = eventQuery.where((eb) =>
        eb.or([
          eb('stream_id', '>', cursor.streamId),
          eb.and([
            eb('stream_id', '=', cursor.streamId),
            eb('sequence', '>', String(cursor.sequence))
          ]),
          eb.and([
            eb('stream_id', '=', cursor.streamId),
            eb('sequence', '=', String(cursor.sequence)),
            eb('id', '>', cursor.id)
          ])
        ])
      )
    }
    const eventRows = await eventQuery
      .orderBy('stream_id', 'asc')
      .orderBy('sequence', 'asc')
      .orderBy('id', 'asc')
      .limit(limit + 1)
      .execute()

    const hasMore = eventRows.length > limit
    const pageRows = hasMore ? eventRows.slice(0, limit) : eventRows
    const last = pageRows.at(-1)
    const nextCursor =
      hasMore && last ? encodeCursor(last.stream_id, Number(last.sequence), last.id) : null

    return {
      session,
      turns: turnRows.map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        status: row.status as 'provisional' | 'finalized',
        contentHash: row.content_hash,
        revision: row.revision,
        firstSequence: Number(row.first_sequence),
        lastSequence: Number(row.last_sequence),
        eventCount: row.event_count,
        firstEventAt: new Date(row.first_event_at).toISOString(),
        lastEventAt: new Date(row.last_event_at).toISOString()
      })),
      events: pageRows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        streamId: row.stream_id,
        sequence: Number(row.sequence),
        type: row.type,
        producerType: row.producer_type,
        provider: row.provider,
        assertion: row.assertion as 'observed' | 'declared' | 'verified',
        trustDomain: row.trust_domain as
          | 'client_observed'
          | 'provider_asserted'
          | 'server_verified',
        classification: row.classification,
        visibility: row.visibility,
        turnId: row.turn_id,
        agentRunId: row.agent_run_id,
        contentHash: row.content_hash,
        occurredAt: new Date(row.occurred_at).toISOString(),
        capturedAt: new Date(row.captured_at).toISOString(),
        receivedAt: new Date(row.received_at).toISOString()
      })),
      nextCursor
    }
  })
}
