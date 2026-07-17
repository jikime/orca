import { describe, expect, test } from 'vitest'
import { defaultViewerPolicy, driverPolicy } from './agent-transcript-visibility'

describe('viewer visibility policy', () => {
  test('default viewer policy hides system and redacts content types', () => {
    expect(defaultViewerPolicy('system')).toBe('hidden')
    expect(defaultViewerPolicy('tool_output')).toBe('redact')
    expect(defaultViewerPolicy('user_prompt')).toBe('redact')
    expect(defaultViewerPolicy('tool_call')).toBe('redact')
    expect(defaultViewerPolicy('assistant_msg')).toBe('redact')
  })

  test('driver policy shows every record type unfiltered', () => {
    for (const type of [
      'system',
      'tool_output',
      'user_prompt',
      'tool_call',
      'assistant_msg'
    ] as const) {
      expect(driverPolicy(type)).toBe('visible')
    }
  })
})
