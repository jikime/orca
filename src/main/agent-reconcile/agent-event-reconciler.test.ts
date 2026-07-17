import { describe, expect, it } from 'vitest'
import { reconcileAgentEvents } from './agent-event-reconciler'
import type { NormalizedHookEvent, NormalizedTranscriptRecord } from './agent-reconcile-types'
import { fakeOutbox, hookEvent, transcriptRecord } from './__fixtures__/agent-reconcile-fixture'

// Builds a 10-turn session: each turn i has a user-prompt hook at odd sequence 2i-1 and an
// assistant transcript record at even sequence 2i, both on turnRef `turn-i`.
function tenTurnTimeline(): {
  hooks: NormalizedHookEvent[]
  transcripts: NormalizedTranscriptRecord[]
} {
  const hooks: NormalizedHookEvent[] = []
  const transcripts: NormalizedTranscriptRecord[] = []
  for (let i = 1; i <= 10; i++) {
    hooks.push(
      hookEvent({
        sequence: 2 * i - 1,
        kind: 'user_prompt',
        turnRef: `turn-${i}`,
        providerRecordKey: `rec-${i}`
      })
    )
    transcripts.push(
      transcriptRecord({
        sequence: 2 * i,
        kind: 'assistant_message',
        turnRef: `turn-${i}`,
        contentHash: `hash-${i}`
      })
    )
  }
  return { hooks, transcripts }
}

describe('reconcileAgentEvents — CAP-001 (hooks miss turns; transcript recovers)', () => {
  it('recovers the full 10-turn timeline after 30% of hook events are dropped, marking gaps', () => {
    const { hooks, transcripts } = tenTurnTimeline()
    // Drop turns 2, 5, 8's hooks (sequences 3, 9, 15) — 30% of the hook stream.
    const droppedSeqs = new Set([3, 9, 15])
    const survivingHooks = hooks.filter((h) => !droppedSeqs.has(h.sequence))
    const outbox = fakeOutbox()

    const result = reconcileAgentEvents({
      hookEvents: survivingHooks,
      transcriptRecords: transcripts,
      enqueue: outbox.enqueue
    })

    // Every turn is present — the timeline is fully recovered from the transcript.
    expect(result.turns).toHaveLength(10)
    expect(result.turns.every((t) => t.finalized)).toBe(true)

    // The 3 hook-dropped turns are recovered from transcript (no hook source).
    const recovered = result.turns.filter((t) => t.recoveredFromTranscript)
    expect(recovered.map((t) => t.turnRef).sort()).toEqual(['turn-2', 'turn-5', 'turn-8'])

    // The sequence holes are MARKED, not silently filled.
    expect(result.gaps).toEqual([
      { streamId: 'session-a', from: 3, to: 3 },
      { streamId: 'session-a', from: 9, to: 9 },
      { streamId: 'session-a', from: 15, to: 15 }
    ])
  })
})

describe('reconcileAgentEvents — CAP-002 (hook timing + transcript content)', () => {
  it('keeps the hook tool-start timing AND finalizes content by the transcript hash, one timeline', () => {
    const outbox = fakeOutbox()
    const preStart = hookEvent({
      sequence: 2,
      kind: 'pre_tool',
      turnRef: 'turn-1',
      toolName: 'Bash',
      toolCallRef: 'call-1',
      providerRecordKey: 'rec-pre'
    })
    const result = reconcileAgentEvents({
      hookEvents: [
        hookEvent({
          sequence: 1,
          kind: 'user_prompt',
          turnRef: 'turn-1',
          providerRecordKey: 'rec-u'
        }),
        preStart,
        hookEvent({
          sequence: 3,
          kind: 'post_tool',
          turnRef: 'turn-1',
          toolCallRef: 'call-1',
          providerRecordKey: 'rec-post'
        })
      ],
      transcriptRecords: [
        // Same tool call as the hook pre/post — must fold into one timeline, not a second event.
        transcriptRecord({
          sequence: 4,
          kind: 'tool_call',
          turnRef: 'turn-1',
          toolCallRef: 'call-1',
          providerRecordKey: 'txn-tool'
        }),
        transcriptRecord({
          sequence: 5,
          kind: 'assistant_message',
          turnRef: 'turn-1',
          contentHash: 'final-hash',
          providerRecordKey: 'txn-fin'
        })
      ],
      enqueue: outbox.enqueue
    })

    // The tool-start moment the transcript lacks is preserved from the hook.
    const started = result.emitted.find((e) => e.type === 'ai.pielab.agent.tool.started.v1')
    expect(started?.time).toBe(preStart.occurredAt)

    // The duplicate transcript tool record was NOT emitted separately (one tool timeline).
    expect(result.emitted.some((e) => e.type === 'ai.pielab.agent.tool.recorded.v1')).toBe(false)

    const turn = result.turns[0]
    expect(turn.finalized).toBe(true)
    expect(turn.contentHash).toBe('final-hash')
    expect(turn.toolCallRefs).toEqual(['call-1'])
  })

  it('a pre_tool with NO post_tool (crash) still surfaces the tool-start and leaves the turn un-finalized', () => {
    const outbox = fakeOutbox()
    const preStart = hookEvent({
      sequence: 2,
      kind: 'pre_tool',
      turnRef: 'turn-1',
      toolName: 'Bash',
      toolCallRef: 'call-1',
      providerRecordKey: 'rec-pre'
    })
    const result = reconcileAgentEvents({
      hookEvents: [
        hookEvent({
          sequence: 1,
          kind: 'user_prompt',
          turnRef: 'turn-1',
          providerRecordKey: 'rec-u'
        }),
        preStart
        // No post_tool and no transcript: the process crashed after the tool started.
      ],
      transcriptRecords: [],
      enqueue: outbox.enqueue
    })

    // The interrupted tool-start (real-time observed) is surfaced with its start timing, not dropped.
    const started = result.emitted.find((e) => e.type === 'ai.pielab.agent.tool.started.v1')
    expect(started?.time).toBe(preStart.occurredAt)
    // The tool never completed — no completion event was fabricated.
    expect(result.emitted.some((e) => e.type === 'ai.pielab.agent.tool.completed.v1')).toBe(false)

    // The incomplete tool stays on the turn timeline; the turn is un-finalized (no transcript hash yet).
    const turn = result.turns[0]
    expect(turn.toolCallRefs).toEqual(['call-1'])
    expect(turn.finalized).toBe(false)
    expect(turn.contentHash).toBeNull()
  })

  it('a later transcript finalizes the crashed turn while preserving the hook tool-start (folded, not doubled)', () => {
    const outbox = fakeOutbox()
    const preStart = hookEvent({
      sequence: 2,
      kind: 'pre_tool',
      turnRef: 'turn-1',
      toolName: 'Bash',
      toolCallRef: 'call-1',
      providerRecordKey: 'rec-pre'
    })
    const result = reconcileAgentEvents({
      hookEvents: [
        hookEvent({
          sequence: 1,
          kind: 'user_prompt',
          turnRef: 'turn-1',
          providerRecordKey: 'rec-u'
        }),
        preStart
      ],
      // The transcript flushed AFTER the crash carries the same tool call + the finalizing content.
      transcriptRecords: [
        transcriptRecord({
          sequence: 3,
          kind: 'tool_call',
          turnRef: 'turn-1',
          toolCallRef: 'call-1',
          providerRecordKey: 'txn-tool'
        }),
        transcriptRecord({
          sequence: 4,
          kind: 'assistant_message',
          turnRef: 'turn-1',
          contentHash: 'final-hash',
          providerRecordKey: 'txn-fin'
        })
      ],
      enqueue: outbox.enqueue
    })

    // The hook tool-start timing survives the later finalize.
    const started = result.emitted.find((e) => e.type === 'ai.pielab.agent.tool.started.v1')
    expect(started?.time).toBe(preStart.occurredAt)
    // The transcript's tool record folded into the one timeline — not re-emitted as a second tool.
    expect(result.emitted.some((e) => e.type === 'ai.pielab.agent.tool.recorded.v1')).toBe(false)

    const turn = result.turns[0]
    expect(turn.finalized).toBe(true)
    expect(turn.contentHash).toBe('final-hash')
    expect(turn.toolCallRefs).toEqual(['call-1'])
  })
})

describe('reconcileAgentEvents — CAP-003 (replay vs re-run vs duplicate prompt)', () => {
  it('a replayed hook (same record key) is idempotent', () => {
    const outbox = fakeOutbox()
    const h = hookEvent({ sequence: 1, providerRecordKey: 'rec-x', turnRef: 'turn-1' })
    const result = reconcileAgentEvents({
      hookEvents: [h, h],
      transcriptRecords: [],
      enqueue: outbox.enqueue
    })
    expect(result.emitted).toHaveLength(1)
    expect(outbox.ids).toHaveLength(1)
  })

  it('a same-text re-run (new record key) is a distinct event', () => {
    const outbox = fakeOutbox()
    const first = hookEvent({ sequence: 1, providerRecordKey: 'rec-a', turnRef: 'turn-1' })
    const rerun = hookEvent({ sequence: 2, providerRecordKey: 'rec-b', turnRef: 'turn-2' })
    const result = reconcileAgentEvents({
      hookEvents: [first, rerun],
      transcriptRecords: [],
      enqueue: outbox.enqueue
    })
    expect(result.emitted).toHaveLength(2)
    expect(new Set(result.emitted.map((e) => e.id)).size).toBe(2)
  })

  it('two identical prompts in one session are distinct turns', () => {
    const outbox = fakeOutbox()
    const a = hookEvent({ sequence: 1, providerRecordKey: 'rec-1', turnRef: 'turn-1' })
    const b = hookEvent({ sequence: 2, providerRecordKey: 'rec-2', turnRef: 'turn-2' })
    const result = reconcileAgentEvents({
      hookEvents: [a, b],
      transcriptRecords: [],
      enqueue: outbox.enqueue
    })
    expect(result.turns).toHaveLength(2)
    expect(new Set(result.turns.map((t) => t.turnKey)).size).toBe(2)
  })
})

describe('reconcileAgentEvents — determinism & outbox dedupe', () => {
  it('same inputs → identical emitted ids and turns', () => {
    const { hooks, transcripts } = tenTurnTimeline()
    const a = reconcileAgentEvents({
      hookEvents: hooks,
      transcriptRecords: transcripts,
      enqueue: () => {}
    })
    const b = reconcileAgentEvents({
      hookEvents: hooks,
      transcriptRecords: transcripts,
      enqueue: () => {}
    })
    expect(a.emitted.map((e) => e.id)).toEqual(b.emitted.map((e) => e.id))
    expect(a.turns).toEqual(b.turns)
    expect(a.gaps).toEqual(b.gaps)
  })

  it('re-running reconcile into the same outbox re-enqueues nothing (dedupe by eventId across restart)', () => {
    const { hooks, transcripts } = tenTurnTimeline()
    const outbox = fakeOutbox()
    reconcileAgentEvents({
      hookEvents: hooks,
      transcriptRecords: transcripts,
      enqueue: outbox.enqueue
    })
    const firstCount = outbox.ids.length
    reconcileAgentEvents({
      hookEvents: hooks,
      transcriptRecords: transcripts,
      enqueue: outbox.enqueue
    })
    expect(outbox.ids).toHaveLength(firstCount)
    expect(outbox.duplicates).toHaveLength(firstCount)
  })
})
