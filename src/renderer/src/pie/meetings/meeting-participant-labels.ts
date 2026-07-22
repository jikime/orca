import { translate } from '@/i18n/i18n'
import type { MeetingParticipant } from './meeting-types'

export function meetingRoleLabel(role: MeetingParticipant['role']): string {
  const labels: Record<MeetingParticipant['role'], string> = {
    host: translate('auto.pie.meetings.role.host', 'Host'),
    co_host: translate('auto.pie.meetings.role.coHost', 'Co-host'),
    presenter: translate('auto.pie.meetings.role.presenter', 'Presenter'),
    participant: translate('auto.pie.meetings.role.participant', 'Participant')
  }
  return labels[role]
}

export function meetingAccessStatusLabel(status: MeetingParticipant['accessStatus']): string {
  const labels: Record<MeetingParticipant['accessStatus'], string> = {
    invited: translate('auto.pie.meetings.access.invited', 'Invited'),
    waiting: translate('auto.pie.meetings.access.waiting', 'Waiting'),
    admitted: translate('auto.pie.meetings.access.admitted', 'Admitted'),
    denied: translate('auto.pie.meetings.access.denied', 'Denied'),
    blocked: translate('auto.pie.meetings.access.blocked', 'Blocked')
  }
  return labels[status]
}
