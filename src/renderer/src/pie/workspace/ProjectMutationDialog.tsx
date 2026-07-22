import { translate } from '@/i18n/i18n'
import { apiPatch, apiPost, resourceEtag } from '../control-plane/pie-api-client'
import type { PieFieldSpec } from './pie-domain-types'
import { PieResourceMutationDialog } from './PieResourceMutationDialog'
import type { ProjectResource } from './project-types'

export function ProjectMutationDialog({
  open,
  project,
  onOpenChange,
  onSaved
}: {
  open: boolean
  project: ProjectResource | null
  onOpenChange: (open: boolean) => void
  onSaved: (project: ProjectResource) => void
}): React.JSX.Element {
  const fields: readonly PieFieldSpec[] = [
    {
      key: 'name',
      label: translate('auto.pie.workspace.ProjectMutationDialog.name', 'Project name'),
      required: true,
      maxLength: 200
    },
    {
      key: 'status',
      label: translate('auto.pie.workspace.ProjectMutationDialog.status', 'Status'),
      type: 'select',
      options: project
        ? ['planned', 'active', 'paused', 'completed', 'cancelled']
        : ['planned', 'active'],
      defaultValue: 'planned',
      required: true
    },
    {
      key: 'summary',
      label: translate('auto.pie.workspace.ProjectMutationDialog.summary', 'Summary'),
      type: 'textarea',
      maxLength: 2000
    }
  ]

  const save = async (body: Record<string, unknown>): Promise<void> => {
    const saved = project
      ? await apiPatch<ProjectResource>(
          `/projects/${project.id}`,
          body,
          resourceEtag('project', project.version)
        )
      : await apiPost<ProjectResource>('/projects', body)
    onSaved(saved)
  }

  return (
    <PieResourceMutationDialog
      open={open}
      onOpenChange={onOpenChange}
      mode={project ? 'edit' : 'create'}
      itemLabel={translate('auto.pie.workspace.ProjectMutationDialog.project', 'project')}
      description={
        project
          ? translate(
              'auto.pie.workspace.ProjectMutationDialog.editDescription',
              'Update the project identity, summary, and lifecycle status.'
            )
          : translate(
              'auto.pie.workspace.ProjectMutationDialog.createDescription',
              'Create a project for related work, delivery controls, and governance records.'
            )
      }
      fields={fields}
      initialValues={project ? { ...project } : null}
      onSubmit={save}
    />
  )
}
