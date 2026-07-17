import { expect, test } from 'vitest'
import {
  createPresenceRoster,
  type CursorEvent,
  type PresenceEvent,
  type RosterParticipant
} from './collab-presence-roster'

// Pure, deterministic roster logic. Time is injected (clock closure); no real timers.
// The control-plane vertical proves the ephemeral wire; this proves the client mirror.

function makeRoster(ttlMs = 1000) {
  let clock = 0
  const rosterEvents: RosterParticipant[][] = []
  const cursorEvents: { participantId: string; row: number; col: number }[] = []
  const roster = createPresenceRoster({
    heartbeatTtlMs: ttlMs,
    now: () => clock,
    onRosterChanged: (r) => rosterEvents.push(r),
    onCursorChanged: (participantId, cursor) =>
      cursorEvents.push({ participantId, row: cursor.row, col: cursor.col })
  })
  return {
    roster,
    rosterEvents,
    cursorEvents,
    setClock: (value: number) => {
      clock = value
    }
  }
}

function presence(overrides: Partial<PresenceEvent> = {}): PresenceEvent {
  return {
    participantId: 'p1',
    userId: 'u1',
    role: 'terminal_control',
    state: 'online',
    at: 0,
    ...overrides
  }
}

function cursor(overrides: Partial<CursorEvent> = {}): CursorEvent {
  return { participantId: 'p1', row: 1, col: 1, at: 0, ...overrides }
}

test('an online presence adds the participant and emits one roster change', () => {
  const { roster, rosterEvents } = makeRoster()
  roster.applyPresence(presence({ at: 100 }))
  expect(roster.list()).toEqual([
    { participantId: 'p1', userId: 'u1', role: 'terminal_control', lastSeenAt: 100 }
  ])
  expect(rosterEvents).toHaveLength(1)
})

test('a heartbeat refresh keeps the participant alive without a redundant roster event', () => {
  const { roster, rosterEvents } = makeRoster()
  roster.applyPresence(presence({ at: 100 }))
  roster.applyPresence(presence({ at: 600 }))
  expect(rosterEvents).toHaveLength(1) // only the initial add
  expect(roster.get('p1')?.lastSeenAt).toBe(600)
})

test('TTL expiry drops a participant whose heartbeat went stale', () => {
  const { roster, rosterEvents, setClock } = makeRoster(1000)
  roster.applyPresence(presence({ at: 100 }))
  setClock(900)
  roster.sweep() // still within TTL
  expect(roster.list()).toHaveLength(1)
  setClock(1200) // 1200 - 1000 = 200 cutoff; lastSeenAt 100 < 200 → expired
  roster.sweep()
  expect(roster.list()).toHaveLength(0)
  expect(rosterEvents).toHaveLength(2) // add + removal
})

test('an offline presence removes the participant and its cursor', () => {
  const { roster, rosterEvents } = makeRoster()
  roster.applyPresence(presence({ at: 100 }))
  roster.applyCursor(cursor({ at: 150, row: 5, col: 5 }))
  roster.applyPresence(presence({ at: 200, state: 'offline' }))
  expect(roster.get('p1')).toBeUndefined()
  expect(rosterEvents).toHaveLength(2) // add + removal
})

test('a cursor update for a known participant emits, and a duplicate does not', () => {
  const { roster, cursorEvents } = makeRoster()
  roster.applyPresence(presence({ at: 100 }))
  roster.applyCursor(cursor({ at: 150, row: 3, col: 7 }))
  roster.applyCursor(cursor({ at: 160, row: 3, col: 7 })) // same position → deduped
  roster.applyCursor(cursor({ at: 170, row: 4, col: 7 })) // moved → emits
  expect(cursorEvents).toEqual([
    { participantId: 'p1', row: 3, col: 7 },
    { participantId: 'p1', row: 4, col: 7 }
  ])
  expect(roster.get('p1')?.cursor).toEqual({ row: 4, col: 7 })
})

test('a cursor for an unknown participant is ignored (no ghost participant)', () => {
  const { roster, cursorEvents } = makeRoster()
  roster.applyCursor(cursor({ participantId: 'ghost', at: 100 }))
  expect(roster.list()).toHaveLength(0)
  expect(cursorEvents).toHaveLength(0)
})

test('an out-of-order presence older than lastSeen is ignored', () => {
  const { roster } = makeRoster()
  roster.applyPresence(presence({ at: 500, role: 'admin' }))
  roster.applyPresence(presence({ at: 200, role: 'observer' })) // stale → ignored
  expect(roster.get('p1')?.role).toBe('admin')
  expect(roster.get('p1')?.lastSeenAt).toBe(500)
})

test('a late cursor older than lastSeen is ignored', () => {
  const { roster, cursorEvents } = makeRoster()
  roster.applyPresence(presence({ at: 300 }))
  roster.applyCursor(cursor({ at: 100, row: 9, col: 9 })) // older than lastSeen → ignored
  expect(cursorEvents).toHaveLength(0)
  expect(roster.get('p1')?.cursor).toBeUndefined()
})

test('an offline for an unknown participant emits nothing', () => {
  const { roster, rosterEvents } = makeRoster()
  roster.applyPresence(presence({ participantId: 'other', at: 200, state: 'offline' }))
  expect(rosterEvents).toHaveLength(0)
})

test('a role change on refresh emits a roster change', () => {
  const { roster, rosterEvents } = makeRoster()
  roster.applyPresence(presence({ at: 100, role: 'observer' }))
  roster.applyPresence(presence({ at: 200, role: 'terminal_control' }))
  expect(rosterEvents).toHaveLength(2)
  expect(roster.get('p1')?.role).toBe('terminal_control')
})
