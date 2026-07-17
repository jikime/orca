import type { NormalizedHookEvent, NormalizedTranscriptRecord } from '../agent-reconcile-types'

// Deterministic fixture builders for the reconciler tests. No clock/RNG — every field is explicit,
// mirroring the normalized shapes the live receiver/watcher (TODO(pie-r5-s3-live)) will produce.

const ORG = '20000000-0000-4000-8000-000000000001'
const HOST = '30000000-0000-4000-8000-000000000009'
const T0 = Date.parse('2026-07-16T10:00:00.000Z')

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString()
}

export function hookEvent(
  overrides: Partial<NormalizedHookEvent> & { sequence: number }
): NormalizedHookEvent {
  return {
    provider: 'claude_code',
    sessionId: 'session-a',
    kind: 'user_prompt',
    providerRecordKey: `rec-${overrides.sequence}`,
    turnRef: `turn-${overrides.sequence}`,
    occurredAt: iso(overrides.sequence * 1000),
    capturedAt: iso(overrides.sequence * 1000 + 5),
    orgId: ORG,
    hostId: HOST,
    ...overrides
  }
}

export function transcriptRecord(
  overrides: Partial<NormalizedTranscriptRecord> & { sequence: number }
): NormalizedTranscriptRecord {
  return {
    provider: 'claude_code',
    sessionId: 'session-a',
    kind: 'assistant_message',
    providerRecordKey: `txn-${overrides.sequence}`,
    turnRef: `turn-${overrides.sequence}`,
    contentHash: `hash-${overrides.sequence}`,
    occurredAt: iso(overrides.sequence * 1000 + 200),
    capturedAt: iso(overrides.sequence * 1000 + 205),
    orgId: ORG,
    hostId: HOST,
    ...overrides
  }
}

// A collector standing in for the s2 outbox: dedupes by eventId exactly like the real store's
// `enqueue`, and records duplicates so tests can assert idempotency.
export function fakeOutbox(): {
  enqueue: (event: { id: string }) => void
  ids: string[]
  duplicates: string[]
} {
  const store = new Set<string>()
  const ids: string[] = []
  const duplicates: string[] = []
  return {
    enqueue: (event) => {
      if (store.has(event.id)) {
        duplicates.push(event.id)
        return
      }
      store.add(event.id)
      ids.push(event.id)
    },
    ids,
    duplicates
  }
}
