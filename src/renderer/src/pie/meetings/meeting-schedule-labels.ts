import { translate } from '@/i18n/i18n'
import type { MeetingRecurrence, MeetingScopeKind } from './meeting-types'

export function meetingRecurrenceLabel(recurrence: MeetingRecurrence): string {
  const labels: Record<MeetingRecurrence, string> = {
    none: translate('auto.pie.meetings.schedule.recurrenceNone', 'Does not repeat'),
    daily: translate('auto.pie.meetings.schedule.recurrenceDaily', 'Daily'),
    weekly: translate('auto.pie.meetings.schedule.recurrenceWeekly', 'Weekly'),
    monthly: translate('auto.pie.meetings.schedule.recurrenceMonthly', 'Monthly')
  }
  return labels[recurrence]
}

export function meetingScopeLabel(scope: MeetingScopeKind): string {
  const labels: Record<MeetingScopeKind, string> = {
    none: translate('auto.pie.meetings.schedule.scopeOrganization', 'Organization'),
    project: translate('auto.pie.meetings.schedule.scopeProject', 'Project'),
    ticket: translate('auto.pie.meetings.schedule.scopeTicket', 'Ticket'),
    remote_session: translate('auto.pie.meetings.schedule.scopeRemoteSession', 'Remote session')
  }
  return labels[scope]
}
