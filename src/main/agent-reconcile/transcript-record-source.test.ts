import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  createTranscriptRecordSource,
  normalizeSessionTranscript
} from './transcript-record-source'

const CTX = { orgId: 'org-1', hostId: 'host-1', capturedAt: '2026-07-16T10:00:00.000Z' }

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'session-a-id',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'session-a',
    title: 'demo',
    cwd: null,
    branch: null,
    model: null,
    filePath: '/tmp/session-a.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-16T09:00:00.000Z',
    messageCount: 3,
    totalTokens: 0,
    previewMessages: [
      { role: 'user', text: 'hello', timestamp: '2026-07-16T09:00:01.000Z' },
      { role: 'tool', text: 'ran bash', timestamp: '2026-07-16T09:00:02.000Z' },
      { role: 'assistant', text: 'done', timestamp: '2026-07-16T09:00:03.000Z' }
    ],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume session-a',
    subagent: null,
    ...overrides
  }
}

describe('normalizeSessionTranscript', () => {
  it('projects preview messages into normalized records grouped under one turn', () => {
    const records = normalizeSessionTranscript(session(), CTX)
    expect(records.map((r) => r.kind)).toEqual(['user_prompt', 'tool_call', 'assistant_message'])
    // Tool + assistant attach to the opening user prompt's turnRef.
    expect(new Set(records.map((r) => r.turnRef)).size).toBe(1)
    expect(records[0].provider).toBe('claude')
    expect(records[1].toolCallRef).toBe('session-a:1')
  })

  it('skips system/unknown rows and hashes content (never stores raw text)', () => {
    const records = normalizeSessionTranscript(
      session({
        previewMessages: [
          { role: 'system', text: 'sys', timestamp: null },
          { role: 'user', text: 'hi', timestamp: null }
        ]
      }),
      CTX
    )
    expect(records).toHaveLength(1)
    expect(records[0].contentHash).not.toContain('hi')
    // Missing timestamp falls back to the session mtime (deterministic, no clock).
    expect(records[0].occurredAt).toBe('2026-07-16T09:00:00.000Z')
  })

  it('is deterministic and idempotent by (sessionId + index)', () => {
    const a = normalizeSessionTranscript(session(), CTX)
    const b = normalizeSessionTranscript(session(), CTX)
    expect(a).toEqual(b)
    expect(a[0].providerRecordKey).toBe('session-a:0')
  })
})

describe('createTranscriptRecordSource', () => {
  it('wraps an injected scanner and normalizes its session', async () => {
    const source = createTranscriptRecordSource(async () => session())
    const records = await source.load({ agent: 'claude', sessionId: 'session-a', ctx: CTX })
    expect(records).toHaveLength(3)
  })

  it('returns no records when the scanner finds nothing', async () => {
    const source = createTranscriptRecordSource(async () => null)
    const records = await source.load({ agent: 'claude', sessionId: 'missing', ctx: CTX })
    expect(records).toEqual([])
  })
})
