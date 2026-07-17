import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'

// Postgres LISTEN/NOTIFY is the Postgres-only broker between the Worker (publish)
// and the Realtime gateway (delivery) — no Redis/Kafka (ADR-0008). The payload is
// a SMALL pointer (org + assigned sequence), well under Postgres' ~8000-byte
// NOTIFY limit; the gateway fetches the full change row from the DB, which stays
// the source of truth. NOTIFY is lossy on disconnect, so the gateway re-listens
// and does a cursor-based catch-up query after any drop.

export const RESOURCE_CHANGED_CHANNEL = 'pie_resource_changed'

export type ResourceChangedNotification = {
  organizationId: string
  sequence: number
}

export function encodeResourceChangedNotification(
  notification: ResourceChangedNotification
): string {
  return JSON.stringify(notification)
}

export function decodeResourceChangedNotification(
  payload: string
): ResourceChangedNotification | null {
  try {
    const parsed = JSON.parse(payload) as Partial<ResourceChangedNotification>
    if (typeof parsed.organizationId === 'string' && typeof parsed.sequence === 'number') {
      return { organizationId: parsed.organizationId, sequence: parsed.sequence }
    }
  } catch {
    // Malformed notification — the gateway falls back to a catch-up query.
  }
  return null
}

// A SEPARATE, non-durable NOTIFY channel for presence/typing. Unlike the resource
// channel, the ephemeral payload IS the full state (no DB row to fetch, no sequence,
// no outbox, no stream_cursors) — it bypasses the durable path entirely so a busy
// presence stream can never starve resource.changed delivery (data over presence).
// It is lossy by design: never buffered, replayed, or caught up after a drop; the
// client re-derives current state (typing clears on TTL, presence re-broadcasts).
export const EPHEMERAL_CHANNEL = 'pie_ephemeral'

export type EphemeralNotification =
  | { kind: 'typing'; organizationId: string; channelId: string; userId: string; at: string }
  | {
      kind: 'presence'
      organizationId: string
      userId: string
      state: 'online' | 'offline'
      at: string
    }
  // Remote-session (doc 34 C4) live presence/cursor. Same lossy, data-over-presence
  // contract as chat typing/presence, but fanned out to a SESSION's participants (not
  // an org or a channel). The payload IS the full state — no row, no outbox, no cursor.
  | {
      kind: 'remote_presence'
      organizationId: string
      sessionId: string
      participantId: string
      userId: string
      state: 'online' | 'offline'
      role: string
      at: string
    }
  | {
      kind: 'remote_cursor'
      organizationId: string
      sessionId: string
      participantId: string
      row: number
      col: number
      at: string
    }

export function encodeEphemeralNotification(notification: EphemeralNotification): string {
  return JSON.stringify(notification)
}

export function decodeEphemeralNotification(payload: string): EphemeralNotification | null {
  try {
    const parsed = JSON.parse(payload) as Partial<EphemeralNotification> & { kind?: unknown }
    if (
      parsed.kind === 'typing' &&
      typeof parsed.organizationId === 'string' &&
      typeof parsed.channelId === 'string' &&
      typeof parsed.userId === 'string' &&
      typeof parsed.at === 'string'
    ) {
      return {
        kind: 'typing',
        organizationId: parsed.organizationId,
        channelId: parsed.channelId,
        userId: parsed.userId,
        at: parsed.at
      }
    }
    if (
      parsed.kind === 'presence' &&
      typeof parsed.organizationId === 'string' &&
      typeof parsed.userId === 'string' &&
      (parsed.state === 'online' || parsed.state === 'offline') &&
      typeof parsed.at === 'string'
    ) {
      return {
        kind: 'presence',
        organizationId: parsed.organizationId,
        userId: parsed.userId,
        state: parsed.state,
        at: parsed.at
      }
    }
    if (
      parsed.kind === 'remote_presence' &&
      typeof parsed.organizationId === 'string' &&
      typeof parsed.sessionId === 'string' &&
      typeof parsed.participantId === 'string' &&
      typeof parsed.userId === 'string' &&
      (parsed.state === 'online' || parsed.state === 'offline') &&
      typeof parsed.role === 'string' &&
      typeof parsed.at === 'string'
    ) {
      return {
        kind: 'remote_presence',
        organizationId: parsed.organizationId,
        sessionId: parsed.sessionId,
        participantId: parsed.participantId,
        userId: parsed.userId,
        state: parsed.state,
        role: parsed.role,
        at: parsed.at
      }
    }
    if (
      parsed.kind === 'remote_cursor' &&
      typeof parsed.organizationId === 'string' &&
      typeof parsed.sessionId === 'string' &&
      typeof parsed.participantId === 'string' &&
      // Cursor coordinates are terminal cells: finite and non-negative, else malformed.
      typeof parsed.row === 'number' &&
      Number.isFinite(parsed.row) &&
      parsed.row >= 0 &&
      typeof parsed.col === 'number' &&
      Number.isFinite(parsed.col) &&
      parsed.col >= 0 &&
      typeof parsed.at === 'string'
    ) {
      return {
        kind: 'remote_cursor',
        organizationId: parsed.organizationId,
        sessionId: parsed.sessionId,
        participantId: parsed.participantId,
        row: parsed.row,
        col: parsed.col,
        at: parsed.at
      }
    }
  } catch {
    // Malformed ephemeral notification — dropped (ephemeral has no catch-up).
  }
  return null
}

/**
 * Fires an ephemeral event as a bare pg_notify — NO transaction, NO outbox row, NO
 * stream_cursors, NO audit. The worker never sees it; every listening gateway does.
 * Best-effort and fire-and-forget: a failure is swallowed (presence/typing self-heal).
 */
export async function fireEphemeralNotification(
  db: Kysely<Database>,
  notification: EphemeralNotification
): Promise<void> {
  try {
    await sql`select pg_notify(${EPHEMERAL_CHANNEL}, ${encodeEphemeralNotification(notification)})`.execute(
      db
    )
  } catch {
    // Ephemeral is lossy by design — dropping one presence/typing ping is harmless.
  }
}
