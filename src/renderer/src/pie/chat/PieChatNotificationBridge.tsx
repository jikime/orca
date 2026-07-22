import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { queuePieChatNavigation } from './pie-chat-navigation'

// Mounted above the active workspace so a native-notification click is buffered
// even when the Pie page (and therefore ChatScreen) is not mounted yet.
export function PieChatNotificationBridge(): null {
  useEffect(
    () =>
      window.api.pie.chat.onNotificationClicked((target) => {
        queuePieChatNavigation(target)
        useAppStore.getState().setActiveView('pie')
      }),
    []
  )
  return null
}
