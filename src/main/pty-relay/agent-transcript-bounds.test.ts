import { describe, expect, test } from 'vitest'
import {
  checkTranscriptBounds,
  DEFAULT_TRANSCRIPT_BOUNDS,
  measureUtf8ByteLength,
  type TranscriptBoundsLimits
} from './agent-transcript-bounds'

const LIMITS: TranscriptBoundsLimits = { maxRecordBytes: 1024, maxLineBytes: 128, maxJsonDepth: 8 }

describe('checkTranscriptBounds', () => {
  test('accepts a healthy record and reports actual bytes', () => {
    const result = checkTranscriptBounds('hello world', LIMITS)
    expect(result).toEqual({ ok: true, bytes: 11 })
  })

  test('quarantines an oversized record (measured, never declared)', () => {
    const huge = 'a'.repeat(5000)
    const result = checkTranscriptBounds(huge, LIMITS)
    expect(result).toEqual({ ok: false, reason: 'record_too_large' })
  })

  test('quarantines a single unbounded line', () => {
    const longLine = 'x'.repeat(200)
    const result = checkTranscriptBounds(longLine, LIMITS)
    expect(result).toEqual({ ok: false, reason: 'line_too_long' })
  })

  test('quarantines deeply nested JSON without parsing / crashing', () => {
    const bomb = '['.repeat(5000) + ']'.repeat(5000)
    // Roomy record/line budgets so the DEPTH bound is the one that fires.
    const result = checkTranscriptBounds(bomb, {
      maxRecordBytes: 1_000_000,
      maxLineBytes: 1_000_000,
      maxJsonDepth: 8
    })
    expect(result).toEqual({ ok: false, reason: 'json_too_deep' })
  })

  test('accepts shallow JSON within the depth limit', () => {
    const result = checkTranscriptBounds('{"a":{"b":[1,2,3]}}', LIMITS)
    expect(result.ok).toBe(true)
  })

  test('does not crash on malformed UTF-8 (lone surrogate)', () => {
    const result = checkTranscriptBounds('bad\uD800text', LIMITS)
    expect(result.ok).toBe(true)
  })

  test('fuzz-ish: never throws across a spread of hostile inputs', () => {
    const inputs = [
      '',
      '{'.repeat(100000),
      `"${'a'.repeat(100000)}`,
      '\uD800\uD800\uD800',
      'x'.repeat(2_000_000),
      `{"deep":${'['.repeat(200)}${']'.repeat(200)}}`,
      '\n'.repeat(10000),
      JSON.stringify({ nested: { a: [1, { b: 2 }] } })
    ]
    for (const input of inputs) {
      expect(() => checkTranscriptBounds(input, LIMITS)).not.toThrow()
    }
  })

  test('measureUtf8ByteLength counts actual encoded bytes', () => {
    expect(measureUtf8ByteLength('a')).toBe(1)
    expect(measureUtf8ByteLength('한')).toBe(3)
  })

  test('default bounds are sane', () => {
    expect(DEFAULT_TRANSCRIPT_BOUNDS.maxRecordBytes).toBeGreaterThan(0)
    expect(DEFAULT_TRANSCRIPT_BOUNDS.maxJsonDepth).toBeGreaterThan(0)
  })
})
