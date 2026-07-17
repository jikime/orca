import { describe, expect, test } from 'vitest'
import { DEFAULT_TRANSCRIPT_BOUNDS, type TranscriptBoundsLimits } from './agent-transcript-bounds'
import { redactTranscriptText } from './agent-transcript-redaction'
import type { RawAgentTranscriptRecord } from './agent-transcript-record'
import {
  createAgentHookTranscriptSource,
  createShareableAgentTranscriptSource,
  type AgentHookEventStream,
  type AgentTranscriptSource,
  type ShareableTranscriptOptions,
  type TranscriptAuditEvent
} from './agent-transcript-source'
import { defaultViewerPolicy, driverPolicy } from './agent-transcript-visibility'

// Fake raw source the tests drive directly — no real hook service.
function createFakeRawSource(snapshot: RawAgentTranscriptRecord[] = []): AgentTranscriptSource & {
  emit(record: RawAgentTranscriptRecord): void
  end(): void
} {
  const recordCbs: ((record: RawAgentTranscriptRecord) => void)[] = []
  const endCbs: (() => void)[] = []
  return {
    onRecord(cb) {
      recordCbs.push(cb)
      return () => {}
    },
    onEnd(cb) {
      endCbs.push(cb)
      return () => {}
    },
    snapshot: () => snapshot,
    emit(record) {
      for (const cb of recordCbs) {
        cb(record)
      }
    },
    end() {
      for (const cb of endCbs) {
        cb()
      }
    }
  }
}

const CANARY = 'CANARY-9a7b-secret'

function makeOptions(overrides: Partial<ShareableTranscriptOptions> = {}): {
  options: ShareableTranscriptOptions
  audits: TranscriptAuditEvent[]
} {
  const audits: TranscriptAuditEvent[] = []
  const options: ShareableTranscriptOptions = {
    viewerPolicy: defaultViewerPolicy,
    redaction: (text) => redactTranscriptText(text, { deny: [CANARY] }),
    bounds: DEFAULT_TRANSCRIPT_BOUNDS,
    isSharingAuthorized: () => true,
    onAudit: (event) => audits.push(event),
    ...overrides
  }
  return { options, audits }
}

describe('createShareableAgentTranscriptSource visibility projection', () => {
  test('viewer never receives system records (hidden + audited)', () => {
    const raw = createFakeRawSource()
    const { options, audits } = makeOptions()
    const shareable = createShareableAgentTranscriptSource(raw, options)
    const received: string[] = []
    shareable.onRecord((r) => received.push(r.type))

    raw.emit({ type: 'system', text: 'internal state' })
    raw.emit({ type: 'user_prompt', text: 'hello' })

    expect(received).toEqual(['user_prompt'])
    expect(audits).toContainEqual({ kind: 'hidden', recordType: 'system' })
  })

  test('viewer receives tool_output only in redacted form', () => {
    const raw = createFakeRawSource()
    const { options } = makeOptions()
    const shareable = createShareableAgentTranscriptSource(raw, options)
    const received: string[] = []
    shareable.onRecord((r) => received.push(r.text))

    raw.emit({ type: 'tool_output', text: `result ${CANARY} done` })

    expect(received).toHaveLength(1)
    expect(received[0]).not.toContain(CANARY)
    expect(received[0]).toContain('‹redacted:deny›')
  })

  test('driver projection is unfiltered and unredacted', () => {
    const raw = createFakeRawSource()
    const { options } = makeOptions({ viewerPolicy: driverPolicy })
    const shareable = createShareableAgentTranscriptSource(raw, options)
    const received: { type: string; text: string }[] = []
    shareable.onRecord((r) => received.push(r))

    raw.emit({ type: 'system', text: 'internal state' })
    raw.emit({ type: 'tool_output', text: `raw ${CANARY}` })

    expect(received).toEqual([
      { type: 'system', text: 'internal state' },
      { type: 'tool_output', text: `raw ${CANARY}` }
    ])
  })
})

describe('createShareableAgentTranscriptSource CAP-003 bounds', () => {
  const tightBounds: TranscriptBoundsLimits = {
    maxRecordBytes: 512,
    maxLineBytes: 128,
    maxJsonDepth: 8
  }

  test('a poison record is quarantined + audited while healthy records still flow', () => {
    const raw = createFakeRawSource()
    const { options, audits } = makeOptions({ bounds: tightBounds })
    const shareable = createShareableAgentTranscriptSource(raw, options)
    const received: string[] = []
    shareable.onRecord((r) => received.push(r.text))

    raw.emit({ type: 'assistant_msg', text: 'healthy-1' })
    raw.emit({ type: 'assistant_msg', text: 'a'.repeat(5000), declaredBytes: 1 }) // oversized, lies about size
    raw.emit({ type: 'assistant_msg', text: '['.repeat(50) }) // json_too_deep
    raw.emit({ type: 'assistant_msg', text: 'healthy-2' })

    expect(received).toEqual(['healthy-1', 'healthy-2']) // poison never starves the stream
    expect(audits).toContainEqual({
      kind: 'quarantined',
      recordType: 'assistant_msg',
      reason: 'record_too_large'
    })
    expect(audits).toContainEqual({
      kind: 'quarantined',
      recordType: 'assistant_msg',
      reason: 'json_too_deep'
    })
  })

  test('never throws on a spread of hostile records', () => {
    const raw = createFakeRawSource()
    const { options } = makeOptions({ bounds: tightBounds })
    const shareable = createShareableAgentTranscriptSource(raw, options)
    shareable.onRecord(() => {})

    const hostile = ['{'.repeat(100000), '\uD800\uD800', 'x'.repeat(2_000_000), '']
    for (const text of hostile) {
      expect(() => raw.emit({ type: 'tool_output', text })).not.toThrow()
    }
  })
})

describe('createShareableAgentTranscriptSource CAP-006 per-record auth', () => {
  test('records are withheld once sharing authorization flips false', () => {
    const raw = createFakeRawSource()
    let authorized = true
    const { options, audits } = makeOptions({ isSharingAuthorized: () => authorized })
    const shareable = createShareableAgentTranscriptSource(raw, options)
    const received: string[] = []
    shareable.onRecord((r) => received.push(r.text))

    raw.emit({ type: 'assistant_msg', text: 'before-revoke' })
    authorized = false
    raw.emit({ type: 'assistant_msg', text: 'after-revoke' })

    expect(received).toEqual(['before-revoke'])
    expect(audits).toContainEqual({ kind: 'blocked_unauthorized', recordType: 'assistant_msg' })
  })

  test('snapshot re-projects and returns empty when unauthorized', () => {
    const raw = createFakeRawSource([
      { type: 'user_prompt', text: 'q1' },
      { type: 'system', text: 'hidden' }
    ])
    const authorized = { value: true }
    const { options } = makeOptions({ isSharingAuthorized: () => authorized.value })
    const shareable = createShareableAgentTranscriptSource(raw, options)

    expect(shareable.snapshot().map((r) => r.type)).toEqual(['user_prompt'])
    authorized.value = false
    expect(shareable.snapshot()).toEqual([])
  })
})

describe('determinism', () => {
  test('same input yields identical shareable projections', () => {
    const records: RawAgentTranscriptRecord[] = [
      { type: 'user_prompt', text: `login with ${CANARY}` },
      { type: 'system', text: 'internal' },
      { type: 'tool_output', text: 'AKIAIOSFODNN7EXAMPLE' }
    ]
    const project = (): { type: string; text: string }[] => {
      const raw = createFakeRawSource()
      const { options } = makeOptions()
      const shareable = createShareableAgentTranscriptSource(raw, options)
      const out: { type: string; text: string }[] = []
      shareable.onRecord((r) => out.push(r))
      for (const record of records) {
        raw.emit(record)
      }
      return out
    }
    expect(project()).toEqual(project())
  })
})

describe('createAgentHookTranscriptSource', () => {
  function createFakeHookStream(): AgentHookEventStream & {
    emit(hookEventName: string, text: string): void
    end(): void
  } {
    const hookCbs: ((event: { hookEventName: string; text: string }) => void)[] = []
    const endCbs: (() => void)[] = []
    return {
      onHookEvent(cb) {
        hookCbs.push(cb)
        return () => {}
      },
      onSessionEnd(cb) {
        endCbs.push(cb)
        return () => {}
      },
      emit(hookEventName, text) {
        for (const cb of hookCbs) {
          cb({ hookEventName, text })
        }
      },
      end() {
        for (const cb of endCbs) {
          cb()
        }
      }
    }
  }

  test('maps hook event names to record types; unknown → system', () => {
    const stream = createFakeHookStream()
    const source = createAgentHookTranscriptSource(stream, { maxSnapshotRecords: 10 })
    const types: string[] = []
    source.onRecord((r) => types.push(r.type))

    stream.emit('UserPromptSubmit', 'hi')
    stream.emit('PreToolUse', 'bash ls')
    stream.emit('PostToolUse', 'file listing')
    stream.emit('Notification', 'something')

    expect(types).toEqual(['user_prompt', 'tool_call', 'tool_output', 'system'])
  })

  test('snapshot ring is bounded to maxSnapshotRecords', () => {
    const stream = createFakeHookStream()
    const source = createAgentHookTranscriptSource(stream, { maxSnapshotRecords: 2 })
    stream.emit('UserPromptSubmit', 'one')
    stream.emit('UserPromptSubmit', 'two')
    stream.emit('UserPromptSubmit', 'three')
    expect(source.snapshot().map((r) => r.text)).toEqual(['two', 'three'])
  })
})
