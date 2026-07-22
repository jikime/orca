import { describe, expect, it } from 'vitest'
import { member, OTHER, USER } from './chat-test-fixtures'
import { chatMemberDisplayName } from './chat-member-display-name'

describe('chatMemberDisplayName', () => {
  const members = [member(USER, 'Ada'), member(OTHER, 'Grace')]

  it('uses the localized self label and roster display names', () => {
    expect(chatMemberDisplayName(USER, members, USER, '나')).toBe('나')
    expect(chatMemberDisplayName(OTHER, members, USER)).toBe('Grace')
  })

  it('falls back to a short id when the roster is stale', () => {
    expect(chatMemberDisplayName('unknown-user', members)).toBe('unknown-')
  })
})
