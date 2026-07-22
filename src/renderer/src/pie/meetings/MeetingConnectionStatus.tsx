import { Wifi, WifiOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { meetingRoleLabel } from './meeting-participant-labels'
import type { MeetingParticipant } from './meeting-types'

export type MeetingConnectionState =
  | 'idle'
  | 'waiting'
  | 'joining'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'recovered'

export function MeetingConnectionStatus({
  state,
  participantCount,
  role
}: {
  state: MeetingConnectionState
  participantCount: number
  role: MeetingParticipant['role'] | null
}): React.JSX.Element {
  const stateLabel = {
    reconnecting: translate('auto.pie.meetings.connection.reconnecting', 'Reconnecting'),
    degraded: translate('auto.pie.meetings.connection.degraded', 'Connection degraded'),
    recovered: translate('auto.pie.meetings.connection.recovered', 'Connection recovered')
  } as const
  return (
    <div className="flex items-center gap-2">
      <Badge variant="secondary">
        {translate('auto.pie.meetings.LiveMeetingRoom.participantCount', '{{value0}} connected', {
          value0: participantCount
        })}
      </Badge>
      {state !== 'connected' && (
        <Badge variant={state === 'degraded' ? 'destructive' : 'outline'}>
          {state === 'degraded' ? <WifiOff /> : <Wifi />}
          {state in stateLabel ? stateLabel[state as keyof typeof stateLabel] : state}
        </Badge>
      )}
      {role && <Badge variant="outline">{meetingRoleLabel(role)}</Badge>}
    </div>
  )
}
