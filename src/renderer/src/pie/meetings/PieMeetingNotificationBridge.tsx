import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { queuePieMeetingNavigation } from './pie-meeting-navigation'

export function PieMeetingNotificationBridge(): null {
  useEffect(
    () =>
      window.api.notifications.onMeetingClicked((target) => {
        queuePieMeetingNavigation(target)
        useAppStore.getState().setActiveView('pie')
      }),
    []
  )
  return null
}
