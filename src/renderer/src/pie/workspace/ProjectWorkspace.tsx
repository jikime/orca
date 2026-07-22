import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { usePieResource } from '../control-plane/use-pie-resource'
import { buildPiePortalDomains } from './pie-domain-registry'
import type { PieDomainConfig } from './pie-domain-types'
import { PieResourceScreen } from './PieResourceScreen'
import { ProjectMutationDialog } from './ProjectMutationDialog'
import { ProjectOverview } from './ProjectOverview'
import type { ProjectResource } from './project-types'
import { WorkItemBoard } from './WorkItemBoard'
import {
  subscribePieWorkItemNavigation,
  takePieWorkItemNavigation
} from './pie-work-item-navigation'

type ProjectTab = 'overview' | 'work' | 'delivery' | 'management'

const DELIVERY_KEYS = ['change-requests', 'deliverables', 'defects'] as const
const MANAGEMENT_KEYS = ['risks', 'decisions', 'status-reports'] as const

function selectDomains(
  domains: readonly PieDomainConfig[],
  keys: readonly string[]
): PieDomainConfig[] {
  return keys.flatMap((key) => {
    const domain = domains.find((candidate) => candidate.key === key)
    return domain ? [domain] : []
  })
}

function ProjectRequired({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">
        {translate(
          'auto.pie.workspace.ProjectWorkspace.projectRequired',
          'Create a project before adding project work.'
        )}
      </p>
      <Button size="sm" onClick={onCreate}>
        <Plus />
        {translate('auto.pie.workspace.ProjectWorkspace.createProject', 'Create project')}
      </Button>
    </div>
  )
}

function DomainTabs({
  domains,
  activeKey,
  onSelect
}: {
  domains: readonly PieDomainConfig[]
  activeKey: string
  onSelect: (key: string) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 border-b border-border bg-muted/20 px-4 py-2">
      {domains.map((domain) => (
        <button
          key={domain.key}
          type="button"
          onClick={() => onSelect(domain.key)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            activeKey === domain.key
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
          )}
        >
          {domain.label}
        </button>
      ))}
    </div>
  )
}

export function ProjectWorkspace(): React.JSX.Element {
  useTranslation()
  const [tab, setTab] = useState<ProjectTab>('overview')
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [deliveryKey, setDeliveryKey] = useState<string>(DELIVERY_KEYS[0])
  const [managementKey, setManagementKey] = useState<string>(MANAGEMENT_KEYS[0])
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<ProjectResource | null>(null)
  const [savedProjects, setSavedProjects] = useState<Record<string, ProjectResource>>({})
  const projectsQuery = usePieResource<{ items: ProjectResource[] }>('/projects')
  const listedProjects = projectsQuery.data?.items
  const projects = useMemo(() => {
    const projectsById = new Map((listedProjects ?? []).map((project) => [project.id, project]))
    for (const project of Object.values(savedProjects)) {
      const listed = projectsById.get(project.id)
      if (!listed || project.version >= listed.version) {
        projectsById.set(project.id, project)
      }
    }
    return [...projectsById.values()]
  }, [listedProjects, savedProjects])
  const projectId = projects.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : (projects[0]?.id ?? '')
  const selectedProject = projects.find((project) => project.id === projectId) ?? null

  const domains = buildPiePortalDomains()
  const deliveryDomains = selectDomains(domains, DELIVERY_KEYS)
  const managementDomains = selectDomains(domains, MANAGEMENT_KEYS)
  const selectedDelivery =
    deliveryDomains.find((domain) => domain.key === deliveryKey) ?? deliveryDomains[0]
  const selectedManagement =
    managementDomains.find((domain) => domain.key === managementKey) ?? managementDomains[0]

  useEffect(() => {
    const openPending = (): void => {
      const target = takePieWorkItemNavigation()
      if (!target) {
        return
      }
      if (target.projectId) {
        setSelectedProjectId(target.projectId)
      }
      setSelectedWorkItemId(target.workItemId)
      setTab('work')
    }
    openPending()
    return subscribePieWorkItemNavigation(openPending)
  }, [])

  const tabs: { key: ProjectTab; label: string }[] = [
    {
      key: 'overview',
      label: translate('auto.pie.workspace.ProjectWorkspace.overview', 'Overview')
    },
    { key: 'work', label: translate('auto.pie.workspace.ProjectWorkspace.work', 'Work') },
    {
      key: 'delivery',
      label: translate('auto.pie.workspace.ProjectWorkspace.delivery', 'Delivery & Quality')
    },
    {
      key: 'management',
      label: translate('auto.pie.workspace.ProjectWorkspace.management', 'Management')
    }
  ]

  const openCreateDialog = (): void => {
    setEditingProject(null)
    setProjectDialogOpen(true)
  }

  const openEditDialog = (): void => {
    if (!selectedProject) {
      return
    }
    setEditingProject(selectedProject)
    setProjectDialogOpen(true)
  }

  const saveProject = (project: ProjectResource): void => {
    // Why: keep the just-saved project visible while the canonical project list refetches.
    setSavedProjects((current) => ({ ...current, [project.id]: project }))
    setSelectedProjectId(project.id)
    setTab('overview')
    projectsQuery.refetch()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <nav
          className="flex items-center gap-1"
          aria-label={translate(
            'auto.pie.workspace.ProjectWorkspace.sectionsLabel',
            'Project sections'
          )}
        >
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              aria-current={tab === item.key ? 'page' : undefined}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                tab === item.key
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {projects.length > 0 && (
            <Select value={projectId} onValueChange={setSelectedProjectId}>
              <SelectTrigger size="sm" className="w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button size="sm" onClick={openCreateDialog}>
            <Plus />
            {translate('auto.pie.workspace.ProjectWorkspace.newProject', 'New project')}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {projectsQuery.loading && projects.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            {translate('auto.pie.workspace.ProjectWorkspace.loading', 'Loading projects…')}
          </div>
        ) : !selectedProject ? (
          <ProjectRequired onCreate={openCreateDialog} />
        ) : tab === 'overview' ? (
          <ProjectOverview
            project={selectedProject}
            onEdit={openEditDialog}
            onOpenWork={() => setTab('work')}
            onOpenDelivery={(key) => {
              setDeliveryKey(key)
              setTab('delivery')
            }}
            onOpenManagement={(key) => {
              setManagementKey(key)
              setTab('management')
            }}
          />
        ) : tab === 'work' ? (
          <WorkItemBoard
            fixedProjectId={projectId}
            initialSelectedId={selectedWorkItemId}
            listenForNavigation={false}
          />
        ) : tab === 'delivery' && selectedDelivery ? (
          <div className="flex h-full min-h-0 flex-col">
            <DomainTabs
              domains={deliveryDomains}
              activeKey={selectedDelivery.key}
              onSelect={setDeliveryKey}
            />
            <div className="min-h-0 flex-1">
              <PieResourceScreen config={selectedDelivery} fixedProjectId={projectId} />
            </div>
          </div>
        ) : tab === 'management' && selectedManagement ? (
          <div className="flex h-full min-h-0 flex-col">
            <DomainTabs
              domains={managementDomains}
              activeKey={selectedManagement.key}
              onSelect={setManagementKey}
            />
            <div className="min-h-0 flex-1">
              <PieResourceScreen config={selectedManagement} fixedProjectId={projectId} />
            </div>
          </div>
        ) : null}
      </div>
      <ProjectMutationDialog
        open={projectDialogOpen}
        project={editingProject}
        onOpenChange={(open) => {
          setProjectDialogOpen(open)
          if (!open) {
            setEditingProject(null)
          }
        }}
        onSaved={saveProject}
      />
    </div>
  )
}
