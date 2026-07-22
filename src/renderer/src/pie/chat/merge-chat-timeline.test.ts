import { describe, expect, it } from 'vitest'
import { message } from './chat-test-fixtures'
import { mergeChatTimeline } from './merge-chat-timeline'

describe('mergeChatTimeline', () => {
  it('keeps older history while replacing refreshed messages by id', () => {
    const older = message({ id: '20000000-0000-4000-8000-000000000011', body: 'older' })
    const current = message({ id: '20000000-0000-4000-8000-000000000012', body: 'before' })
    const refreshed = message({ ...current, body: 'after', edited: true })

    expect(mergeChatTimeline([older, current], [refreshed]).map((item) => item.body)).toEqual([
      'older',
      'after'
    ])
  })

  it('sorts pages into chronological order', () => {
    const early = message({
      id: '20000000-0000-4000-8000-000000000011',
      createdAt: '2026-07-16T00:00:00.000Z'
    })
    const late = message({
      id: '20000000-0000-4000-8000-000000000012',
      createdAt: '2026-07-16T00:01:00.000Z'
    })

    expect(mergeChatTimeline([late], [early]).map((item) => item.id)).toEqual([early.id, late.id])
  })
})
