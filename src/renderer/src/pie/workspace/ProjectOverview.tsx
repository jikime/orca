import {
  AlertTriangle,
  Bug,
  ClipboardList,
  FileCheck2,
  Gavel,
  MessagesSquare,
  Pencil,
  RefreshCw
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { translate } from '@/i18n/i18n'
import { PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import { openPieResourceConversation } from './pie-resource-conversation'
import { PieResourceMeetingLinks } from './PieResourceMeetingLinks'
import { ProjectMetricCard, ProjectSummaryRow } from './ProjectOverviewMetrics'
import { PieStatusBadge } from './PieStatusBadge'
import type { ProjectGovernanceSummary, ProjectResource } from './project-types'

type WorkItemSummary = { id: string; priority: string; assigneeId: string | null }
type ChangeRequestSummary = { id: string; status: string }
type DeliverableSummary = { id: string; status: string }
type DefectSummary = { id: string; status: string }

export function ProjectOverview({
  project,
  onEdit,
  onOpenWork,
  onOpenDelivery,
  onOpenManagement
}: {
  project: ProjectResource
  onEdit: () => void
  onOpenWork: () => void
  onOpenDelivery: (key: 'change-requests' | 'deliverables' | 'defects') => void
  onOpenManagement: (key: 'risks' | 'decisions' | 'status-reports') => void
}): React.JSX.Element {
  const [conversationBusy, setConversationBusy] = useState(false)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const work = usePieResource<{ items: WorkItemSummary[] }>(
    `/work-items?projectId=${encodeURIComponent(project.id)}`
  )
  const changes = usePieResource<{ items: ChangeRequestSummary[] }>(
    `/projects/${project.id}/change-requests`
  )
  const deliverables = usePieResource<{ items: DeliverableSummary[] }>(
    `/projects/${project.id}/deliverables`
  )
  const defects = usePieResource<{ items: DefectSummary[] }>(`/projects/${project.id}/defects`)
  const governance = usePieResource<ProjectGovernanceSummary>(`/projects/${project.id}/governance`)

  const workItems = work.data?.items ?? []
  const changeItems = changes.data?.items ?? []
  const deliverableItems = deliverables.data?.items ?? []
  const defectItems = defects.data?.items ?? []
  const pendingChanges = changeItems.filter(
    (item) => item.status !== 'rejected' && item.status !== 'applied'
  ).length
  const outstandingDeliverables = deliverableItems.filter(
    (item) => item.status !== 'accepted'
  ).length
  const openDefects = defectItems.filter(
    (item) => item.status !== 'closed' && item.status !== 'wontfix'
  ).length
  const unassignedWork = workItems.filter((item) => !item.assigneeId).length
  const highPriorityWork = workItems.filter(
    (item) => item.priority === 'urgent' || item.priority === 'high'
  ).length
  const loading =
    work.loading || changes.loading || deliverables.loading || defects.loading || governance.loading
  const loadError =
    work.error || changes.error || deliverables.error || defects.error || governance.error
  const metric = (value: number): string => (loading ? '—' : String(value))
  const riskSummary = governance.data

  const retry = (): void => {
    work.refetch()
    changes.refetch()
    deliverables.refetch()
    defects.refetch()
    governance.refetch()
  }

  const openConversation = async (): Promise<void> => {
    setConversationBusy(true)
    setConversationError(null)
    try {
      await openPieResourceConversation({
        scopeType: 'project',
        resourceId: project.id,
        label: project.name
      })
    } catch (caught) {
      setConversationError(
        caught instanceof PieApiError
          ? `${caught.code ?? caught.status}: ${caught.message}`
          : translate(
              'auto.pie.workspace.ProjectOverview.chatError',
              'Could not open the project conversation.'
            )
      )
    } finally {
      setConversationBusy(false)
    }
  }

  return (
    <ScrollArea className="h-full" viewportClassName="p-4">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <section className="flex flex-wrap items-start gap-4 border-b border-border pb-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-foreground">{project.name}</h2>
              <PieStatusBadge value={project.status} />
            </div>
            <p className="mt-1 max-w-3xl text-sm whitespace-pre-wrap text-muted-foreground">
              {project.summary ||
                translate(
                  'auto.pie.workspace.ProjectOverview.noSummary',
                  'Add a summary so the project purpose is visible to the team.'
                )}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {translate('auto.pie.workspace.ProjectOverview.updated', 'Updated {{value0}}', {
                value0: new Date(project.updatedAt).toLocaleString()
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={conversationBusy}
              onClick={() => void openConversation()}
            >
              <MessagesSquare />
              {translate(
                'auto.pie.workspace.ProjectOverview.openConversation',
                'Open conversation'
              )}
            </Button>
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil />
              {translate('auto.pie.workspace.ProjectOverview.edit', 'Edit project')}
            </Button>
          </div>
        </section>

        {loadError && (
          <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span className="min-w-0 flex-1">
              {translate(
                'auto.pie.workspace.ProjectOverview.loadError',
                'Some project metrics could not be loaded.'
              )}
            </span>
            <Button size="xs" variant="outline" onClick={retry}>
              <RefreshCw />
              {translate('auto.pie.workspace.ProjectOverview.retry', 'Retry')}
            </Button>
          </div>
        )}

        {conversationError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {conversationError}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <ProjectMetricCard
            icon={ClipboardList}
            label={translate('auto.pie.workspace.ProjectOverview.workItems', 'Work items')}
            value={metric(workItems.length)}
            detail={translate(
              'auto.pie.workspace.ProjectOverview.workDetail',
              '{{value0}} unassigned · {{value1}} high priority',
              { value0: unassignedWork, value1: highPriorityWork }
            )}
          />
          <ProjectMetricCard
            icon={FileCheck2}
            label={translate(
              'auto.pie.workspace.ProjectOverview.pendingChanges',
              'Pending changes'
            )}
            value={metric(pendingChanges)}
            detail={translate(
              'auto.pie.workspace.ProjectOverview.changeDetail',
              '{{value0}} total change requests',
              { value0: changeItems.length }
            )}
          />
          <ProjectMetricCard
            icon={Bug}
            label={translate('auto.pie.workspace.ProjectOverview.openDefects', 'Open defects')}
            value={metric(openDefects)}
            detail={translate(
              'auto.pie.workspace.ProjectOverview.defectDetail',
              '{{value0}} total defects',
              { value0: defectItems.length }
            )}
          />
          <ProjectMetricCard
            icon={AlertTriangle}
            label={translate('auto.pie.workspace.ProjectOverview.openRisks', 'Open risks')}
            value={metric(riskSummary?.openRiskCount ?? 0)}
            detail={translate(
              'auto.pie.workspace.ProjectOverview.riskDetail',
              '{{value0}} critical · {{value1}} high',
              {
                value0: riskSummary?.openRisksBySeverity.critical ?? 0,
                value1: riskSummary?.openRisksBySeverity.high ?? 0
              }
            )}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="gap-3 py-4 shadow-xs">
            <CardHeader className="grid-cols-[1fr_auto] px-4">
              <CardTitle className="text-sm">
                {translate(
                  'auto.pie.workspace.ProjectOverview.deliveryTitle',
                  'Delivery & quality'
                )}
              </CardTitle>
              <Button size="xs" variant="ghost" onClick={onOpenWork}>
                {translate('auto.pie.workspace.ProjectOverview.openWork', 'Open work')}
              </Button>
            </CardHeader>
            <CardContent className="px-4">
              <ProjectSummaryRow
                label={translate(
                  'auto.pie.workspace.ProjectOverview.pendingChangeRows',
                  'Pending change requests'
                )}
                value={pendingChanges}
              />
              <button
                type="button"
                className="w-full text-left hover:bg-accent"
                onClick={() => onOpenDelivery('deliverables')}
              >
                <ProjectSummaryRow
                  label={translate(
                    'auto.pie.workspace.ProjectOverview.outstandingDeliverables',
                    'Outstanding deliverables'
                  )}
                  value={outstandingDeliverables}
                />
              </button>
              <button
                type="button"
                className="w-full text-left hover:bg-accent"
                onClick={() => onOpenDelivery('defects')}
              >
                <ProjectSummaryRow
                  label={translate(
                    'auto.pie.workspace.ProjectOverview.openDefectRows',
                    'Open defects'
                  )}
                  value={openDefects}
                />
              </button>
              <Button
                size="xs"
                variant="outline"
                className="mt-3"
                onClick={() => onOpenDelivery('change-requests')}
              >
                {translate(
                  'auto.pie.workspace.ProjectOverview.openChanges',
                  'Open change requests'
                )}
              </Button>
            </CardContent>
          </Card>

          <Card className="gap-3 py-4 shadow-xs">
            <CardHeader className="grid-cols-[1fr_auto] px-4">
              <CardTitle className="text-sm">
                {translate('auto.pie.workspace.ProjectOverview.governanceTitle', 'Management')}
              </CardTitle>
              <Button size="xs" variant="ghost" onClick={() => onOpenManagement('risks')}>
                {translate('auto.pie.workspace.ProjectOverview.openRisksAction', 'Open risks')}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 px-4">
              <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3">
                <FileCheck2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold text-foreground">
                      {translate(
                        'auto.pie.workspace.ProjectOverview.latestReport',
                        'Latest status report'
                      )}
                    </p>
                    <PieStatusBadge value={riskSummary?.latestStatusReport?.overallStatus} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {riskSummary?.latestStatusReport?.summary ||
                      translate(
                        'auto.pie.workspace.ProjectOverview.noReport',
                        'No status report has been created.'
                      )}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onOpenManagement('status-reports')}
                >
                  {translate('auto.pie.workspace.ProjectOverview.open', 'Open')}
                </Button>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2">
                  <Gavel className="size-4 text-muted-foreground" />
                  <p className="text-xs font-semibold text-foreground">
                    {translate(
                      'auto.pie.workspace.ProjectOverview.recentDecisions',
                      'Recent decisions'
                    )}
                  </p>
                </div>
                {(riskSummary?.recentDecisions ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {translate(
                      'auto.pie.workspace.ProjectOverview.noDecisions',
                      'No project decisions have been recorded.'
                    )}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {riskSummary?.recentDecisions.slice(0, 3).map((decision) => (
                      <button
                        key={decision.id}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                        onClick={() => onOpenManagement('decisions')}
                      >
                        <span className="truncate text-xs text-foreground">{decision.title}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {new Date(decision.decidedAt).toLocaleDateString()}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <PieResourceMeetingLinks scopeKind="project" resourceId={project.id} title={project.name} />
      </div>
    </ScrollArea>
  )
}
