import { describe, expect, it } from 'vitest'
import { buildNotificationOptions } from './notification-options'

describe('Pie chat native notification options', () => {
  it('uses the channel label and safe message preview', () => {
    expect(
      buildNotificationOptions({
        source: 'pie-chat',
        chatChannelLabel: '#general',
        chatBodyPreview: 'Please review the launch checklist.'
      })
    ).toEqual({
      title: 'New message in #general',
      body: 'Please review the launch checklist.'
    })
  })

  it('formats a scheduled meeting reminder', () => {
    expect(
      buildNotificationOptions({
        source: 'pie-meeting',
        meetingTitle: 'Release review',
        meetingStartLabel: 'July 21, 1:00 PM'
      })
    ).toEqual({
      title: 'Meeting soon: Release review',
      body: 'Scheduled for July 21, 1:00 PM. Open Orca to join.'
    })
  })
})
