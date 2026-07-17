// Client-side roster of the OTHER participants in a shared remote/terminal session
// (doc 34 C4). It reflects the control plane's EPHEMERAL presence/cursor channel — a
// lossy, data-over-presence stream where the payload IS the full state, never replayed
// or caught up. So this module holds no authority: it only mirrors injected events and
// expires a participant whose heartbeat has gone stale (TTL), so a departed participant
// cannot linger. It owns no clock and no timers — time is injected via now() so the
// roster is deterministic; the caller decides when to advance and sweep.
//
// The local driver's OWN cursor is derived from the output stream by the headless
// emulator, NOT from here — this roster is only for sharing/observing OTHERS.

export type PresenceState = 'online' | 'offline'

export type PresenceEvent = {
  participantId: string
  userId: string
  role: string
  state: PresenceState
  // Monotonic-ish origin timestamp (ms). Older-than-lastSeen events are ignored so a
  // late/out-of-order NOTIFY can't resurrect or rewind a participant.
  at: number
}

export type CursorEvent = {
  participantId: string
  row: number
  col: number
  at: number
}

export type RosterCursor = { row: number; col: number }

export type RosterParticipant = {
  participantId: string
  userId: string
  role: string
  lastSeenAt: number
  cursor?: RosterCursor
}

export type PresenceRosterOptions = {
  // A participant is dropped once (now - lastSeenAt) exceeds this TTL. Because presence
  // is lossy, absence of heartbeats — not an explicit offline — is the primary signal.
  heartbeatTtlMs: number
  // Injected clock seam. NO Date.now() in this module — the caller passes time in.
  now: () => number
  // Fired only when the set/identity of participants actually changes (deduped).
  onRosterChanged?: (roster: RosterParticipant[]) => void
  // Fired only when a participant's cursor actually changes (deduped).
  onCursorChanged?: (participantId: string, cursor: RosterCursor) => void
}

export type PresenceRoster = {
  applyPresence(event: PresenceEvent): void
  applyCursor(event: CursorEvent): void
  // Drops every participant whose lastSeenAt is older than the TTL relative to now().
  // Deterministic: the caller decides when to sweep (no internal timer).
  sweep(): void
  list(): RosterParticipant[]
  get(participantId: string): RosterParticipant | undefined
}

function snapshot(participant: RosterParticipant): RosterParticipant {
  // Copy so callers can't mutate internal state, and cursor identity is stable.
  return {
    participantId: participant.participantId,
    userId: participant.userId,
    role: participant.role,
    lastSeenAt: participant.lastSeenAt,
    ...(participant.cursor
      ? { cursor: { row: participant.cursor.row, col: participant.cursor.col } }
      : {})
  }
}

export function createPresenceRoster(options: PresenceRosterOptions): PresenceRoster {
  const participants = new Map<string, RosterParticipant>()

  const emitRoster = (): void => {
    options.onRosterChanged?.([...participants.values()].map(snapshot))
  }

  const remove = (participantId: string): boolean => {
    return participants.delete(participantId)
  }

  return {
    applyPresence(event) {
      const existing = participants.get(event.participantId)
      // Ignore a stale/out-of-order event that is older than what we already have.
      if (existing && event.at < existing.lastSeenAt) {
        return
      }
      if (event.state === 'offline') {
        // An explicit offline (or its TTL equivalent) drops the participant AND its
        // cursor — a stale cursor never outlives its owner.
        if (remove(event.participantId)) {
          emitRoster()
        }
        return
      }
      if (!existing) {
        participants.set(event.participantId, {
          participantId: event.participantId,
          userId: event.userId,
          role: event.role,
          lastSeenAt: event.at
        })
        emitRoster()
        return
      }
      // Heartbeat refresh of a known participant. Emit only on a real identity change
      // (role/userId) — a pure lastSeenAt bump keeps them alive without a redundant event.
      const identityChanged = existing.role !== event.role || existing.userId !== event.userId
      existing.lastSeenAt = event.at
      existing.role = event.role
      existing.userId = event.userId
      if (identityChanged) {
        emitRoster()
      }
    },

    applyCursor(event) {
      const existing = participants.get(event.participantId)
      // A cursor for an unknown participant is dropped — presence establishes the roster
      // first; a cursor never creates a ghost participant.
      if (!existing) {
        return
      }
      if (event.at < existing.lastSeenAt) {
        return
      }
      existing.lastSeenAt = event.at
      const unchanged =
        existing.cursor !== undefined &&
        existing.cursor.row === event.row &&
        existing.cursor.col === event.col
      existing.cursor = { row: event.row, col: event.col }
      if (!unchanged) {
        options.onCursorChanged?.(event.participantId, { row: event.row, col: event.col })
      }
    },

    sweep() {
      const cutoff = options.now() - options.heartbeatTtlMs
      let changed = false
      for (const [participantId, participant] of participants) {
        if (participant.lastSeenAt < cutoff) {
          participants.delete(participantId)
          changed = true
        }
      }
      if (changed) {
        emitRoster()
      }
    },

    list() {
      return [...participants.values()].map(snapshot)
    },

    get(participantId) {
      const participant = participants.get(participantId)
      return participant ? snapshot(participant) : undefined
    }
  }
}
