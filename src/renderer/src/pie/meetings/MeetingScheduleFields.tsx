import { Clock } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { MeetingRecurrence } from './meeting-types'
import { meetingTimeZones } from './meeting-schedule-time'
import { meetingRecurrenceLabel } from './meeting-schedule-labels'

export type MeetingScheduleDraft = {
  start: string
  end: string
  timeZone: string
  recurrence: MeetingRecurrence
}

const TIME_ZONES = meetingTimeZones()

export function MeetingScheduleFields({
  value,
  onChange
}: {
  value: MeetingScheduleDraft
  onChange: (value: MeetingScheduleDraft) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Input
          type="datetime-local"
          value={value.start}
          onChange={(event) =>
            onChange({
              ...value,
              start: event.target.value,
              ...(!event.target.value ? { end: '', recurrence: 'none' as const } : {})
            })
          }
          aria-label={translate('auto.pie.meetings.MeetingWorkspace.startTime', 'Start time')}
        />
        <Input
          type="datetime-local"
          value={value.end}
          min={value.start || undefined}
          disabled={!value.start}
          onChange={(event) => onChange({ ...value, end: event.target.value })}
          aria-label={translate('auto.pie.meetings.MeetingWorkspace.endTime', 'End time')}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={value.timeZone}
          onValueChange={(timeZone) => onChange({ ...value, timeZone })}
        >
          <SelectTrigger
            className="w-full"
            aria-label={translate('auto.pie.meetings.schedule.timeZone', 'Time zone')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIME_ZONES.map((zone) => (
              <SelectItem key={zone} value={zone}>
                {zone}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={value.recurrence}
          disabled={!value.start}
          onValueChange={(recurrence) =>
            onChange({ ...value, recurrence: recurrence as MeetingRecurrence })
          }
        >
          <SelectTrigger
            className="w-full"
            aria-label={translate('auto.pie.meetings.schedule.recurrence', 'Recurrence')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['none', 'daily', 'weekly', 'monthly'] as const).map((recurrence) => (
              <SelectItem key={recurrence} value={recurrence}>
                {meetingRecurrenceLabel(recurrence)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value.start && (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Clock className="size-3" />
          {translate(
            'auto.pie.meetings.MeetingWorkspace.reminder',
            'A desktop reminder appears 10 minutes before each occurrence.'
          )}
        </p>
      )}
    </div>
  )
}
