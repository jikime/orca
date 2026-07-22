import { describe, expect, it } from 'vitest'
import { isChatDndActive } from './chat-do-not-disturb'
import type { PieNotificationPreferences } from '../../../../shared/pie-chat-contract'

function preferences(
  overrides: Partial<PieNotificationPreferences> = {}
): PieNotificationPreferences {
  return {
    desktopEnabled: true,
    dndEnabled: true,
    dndStartMinute: 22 * 60,
    dndEndMinute: 8 * 60,
    timezone: 'UTC',
    channelLevels: [],
    ...overrides
  }
}

describe('chat do not disturb', () => {
  it('handles an overnight quiet window in the configured timezone', () => {
    expect(isChatDndActive(preferences(), new Date('2026-07-20T23:00:00Z'))).toBe(true)
    expect(isChatDndActive(preferences(), new Date('2026-07-20T07:59:00Z'))).toBe(true)
    expect(isChatDndActive(preferences(), new Date('2026-07-20T08:00:00Z'))).toBe(false)
  })

  it('handles a same-day window and disables suppression when DND is off', () => {
    const daytime = preferences({ dndStartMinute: 9 * 60, dndEndMinute: 17 * 60 })
    expect(isChatDndActive(daytime, new Date('2026-07-20T12:00:00Z'))).toBe(true)
    expect(isChatDndActive(daytime, new Date('2026-07-20T18:00:00Z'))).toBe(false)
    expect(isChatDndActive({ ...daytime, dndEnabled: false }, new Date())).toBe(false)
  })
})
