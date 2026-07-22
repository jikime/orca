import { useEffect, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { apiGet, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import { MeetingActionItemRow } from './MeetingActionItemRow'
import { MeetingDecisionRow } from './MeetingDecisionRow'
import { requestMeetingRecordingSeek } from './meeting-recording-navigation'
import type { MeetingActionItem, MeetingDecision, MeetingTranscriptSegment } from './meeting-types'

export function MeetingOutcomesPanel({
  meetingId,
  permissions,
  focusedActionItemId
}: {
  meetingId: string
  permissions: string[]
  focusedActionItemId?: string | null
}): React.JSX.Element {
  const decisions = usePieResource<{ items: MeetingDecision[] }>(`/meetings/${meetingId}/decisions`)
  const actionItems = usePieResource<{ items: MeetingActionItem[] }>(
    `/meetings/${meetingId}/action-items`
  )
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState(focusedActionItemId ? 'actions' : 'decisions')
  const decisionItems = decisions.data?.items ?? []
  const actionItemItems = actionItems.data?.items ?? []

  useEffect(() => {
    if (focusedActionItemId) {
      setActiveTab('actions')
    }
  }, [focusedActionItemId])

  const openEvidence = async (segmentId: string): Promise<void> => {
    setError(null)
    try {
      const segment = await apiGet<MeetingTranscriptSegment>(
        `/meeting-transcript-segments/${segmentId}`
      )
      requestMeetingRecordingSeek(segment.startMs)
    } catch (caught) {
      setError(
        caught instanceof PieApiError
          ? `${caught.code ?? caught.status}: ${caught.message}`
          : caught instanceof Error
            ? caught.message
            : String(caught)
      )
    }
  }

  const empty = (label: string): React.JSX.Element => (
    <p className="py-4 text-center text-xs text-muted-foreground">{label}</p>
  )

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <ListChecks className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.pie.meetings.outcomes.title', 'Decisions & action items')}
        </h3>
      </div>
      <Tabs value={activeTab} onValueChange={setActiveTab} className="p-3">
        <TabsList className="w-full">
          <TabsTrigger value="decisions">
            {translate('auto.pie.meetings.outcomes.decisions', 'Decisions')} ·{' '}
            {decisionItems.length}
          </TabsTrigger>
          <TabsTrigger value="actions">
            {translate('auto.pie.meetings.outcomes.actions', 'Actions')} · {actionItemItems.length}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="decisions" className="space-y-2">
          {decisions.loading
            ? empty(translate('auto.pie.meetings.outcomes.loading', 'Loading…'))
            : decisionItems.length === 0
              ? empty(
                  translate('auto.pie.meetings.outcomes.noDecisions', 'No decisions captured yet.')
                )
              : decisionItems.map((decision) => (
                  <MeetingDecisionRow
                    key={decision.id}
                    decision={decision}
                    canManage={permissions.includes('meeting.manage')}
                    canReview={permissions.includes('meeting.minutes.review')}
                    onChanged={decisions.refetch}
                    onOpenEvidence={(segmentId) => void openEvidence(segmentId)}
                  />
                ))}
        </TabsContent>
        <TabsContent value="actions" className="space-y-2">
          {actionItems.loading
            ? empty(translate('auto.pie.meetings.outcomes.loading', 'Loading…'))
            : actionItemItems.length === 0
              ? empty(
                  translate('auto.pie.meetings.outcomes.noActions', 'No action items captured yet.')
                )
              : actionItemItems.map((actionItem) => (
                  <MeetingActionItemRow
                    key={actionItem.id}
                    actionItem={actionItem}
                    canManage={permissions.includes('meeting.manage')}
                    canReview={permissions.includes('meeting.minutes.review')}
                    canCreateWork={permissions.includes('work_item.create')}
                    focused={actionItem.id === focusedActionItemId}
                    onChanged={actionItems.refetch}
                    onOpenEvidence={(segmentId) => void openEvidence(segmentId)}
                  />
                ))}
        </TabsContent>
      </Tabs>
      {(error || decisions.error || actionItems.error) && (
        <p className="border-t border-border px-3 py-2 text-xs text-destructive">
          {error ?? decisions.error ?? actionItems.error}
        </p>
      )}
    </section>
  )
}
