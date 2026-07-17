import type SyncDatabase from '../sqlite/sync-database'
import type { SqliteStatement } from '../sqlite/sync-database'
import type { AgentEventAssertion } from './agent-event-outbox-store'

// Schema DDL + prepared-statement bundle for the outbox store, kept separate from the store's
// operations so the table shape and the (single-writer) statement set live in one place.

export type OutboxRow = {
  event_id: string
  stream_id: string
  sequence: number
  byte_size: number
  attempt_count: number
  assertion: AgentEventAssertion
  envelope: string
}

export type UnackedRow = {
  event_id: string
  stream_id: string
  sequence: number
  byte_size: number
  assertion: AgentEventAssertion
}

export type OutboxStatements = {
  existsEvent: SqliteStatement
  insertEvent: SqliteStatement
  unackedCount: SqliteStatement
  unackedBytes: SqliteStatement
  claimSelect: SqliteStatement
  markInflight: SqliteStatement
  setAcked: SqliteStatement
  ackedByteSum: SqliteStatement
  nack: SqliteStatement
  oldestPending: SqliteStatement
  selectUnacked: SqliteStatement
  deleteEvent: SqliteStatement
  pruneAcked: SqliteStatement
  upsertCursor: SqliteStatement
  getCursor: SqliteStatement
}

// UNIQUE(event_id): a re-enqueue of the same eventId (crash-retry) is a no-op, so the outbox
// never holds two rows for one event and a replay never duplicates downstream.
export const OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS agent_event_outbox (
    row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        TEXT NOT NULL,
    stream_id       TEXT NOT NULL,
    sequence        INTEGER NOT NULL,
    envelope        TEXT NOT NULL,
    byte_size       INTEGER NOT NULL,
    assertion       TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'pending'
      CHECK(state IN ('pending', 'inflight', 'acked')),
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    enqueued_at     INTEGER NOT NULL,
    next_visible_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_event_id ON agent_event_outbox(event_id);
  CREATE INDEX IF NOT EXISTS idx_outbox_claim
    ON agent_event_outbox(state, next_visible_at, row_id);

  CREATE TABLE IF NOT EXISTS agent_event_cursor (
    stream_id          TEXT PRIMARY KEY,
    contiguous_through INTEGER NOT NULL DEFAULT 0
  );
`

export function prepareOutboxStatements(db: SyncDatabase): OutboxStatements {
  const unacked = "state IN ('pending', 'inflight')"
  return {
    existsEvent: db.prepare('SELECT 1 FROM agent_event_outbox WHERE event_id = ?'),
    insertEvent: db.prepare(`
      INSERT INTO agent_event_outbox
        (event_id, stream_id, sequence, envelope, byte_size, assertion, enqueued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `),
    unackedCount: db.prepare(`SELECT COUNT(*) AS c FROM agent_event_outbox WHERE ${unacked}`),
    unackedBytes: db.prepare(
      `SELECT COALESCE(SUM(byte_size), 0) AS b FROM agent_event_outbox WHERE ${unacked}`
    ),
    claimSelect: db.prepare(`
      SELECT event_id, stream_id, sequence, byte_size, attempt_count, assertion, envelope
      FROM agent_event_outbox
      WHERE state = 'pending' AND next_visible_at <= ?
      ORDER BY row_id ASC
      LIMIT ?
    `),
    markInflight: db.prepare(
      "UPDATE agent_event_outbox SET state = 'inflight' WHERE event_id = ? AND state = 'pending'"
    ),
    setAcked: db.prepare("UPDATE agent_event_outbox SET state = 'acked' WHERE event_id = ?"),
    ackedByteSum: db.prepare(
      "SELECT COALESCE(SUM(byte_size), 0) AS b FROM agent_event_outbox WHERE state = 'acked'"
    ),
    nack: db.prepare(`
      UPDATE agent_event_outbox
      SET state = 'pending', attempt_count = attempt_count + 1, next_visible_at = ?
      WHERE event_id = ?
    `),
    oldestPending: db.prepare(`
      SELECT event_id, stream_id, sequence, byte_size, assertion
      FROM agent_event_outbox
      WHERE state = 'pending'
      ORDER BY row_id ASC
      LIMIT ?
    `),
    selectUnacked: db.prepare(`
      SELECT event_id, stream_id, sequence, byte_size, assertion
      FROM agent_event_outbox
      WHERE state IN ('pending', 'inflight')
      ORDER BY row_id ASC
    `),
    deleteEvent: db.prepare('DELETE FROM agent_event_outbox WHERE event_id = ?'),
    pruneAcked: db.prepare("DELETE FROM agent_event_outbox WHERE state = 'acked'"),
    upsertCursor: db.prepare(`
      INSERT INTO agent_event_cursor (stream_id, contiguous_through)
      VALUES (?, ?)
      ON CONFLICT(stream_id)
      DO UPDATE SET contiguous_through = MAX(contiguous_through, excluded.contiguous_through)
    `),
    getCursor: db.prepare(
      'SELECT contiguous_through AS c FROM agent_event_cursor WHERE stream_id = ?'
    )
  }
}
