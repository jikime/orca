import type { PieSessionState } from '../../../../shared/pie-session-contract'
import {
  PIE_WORKSPACE_CONTEXT_SCHEMA_VERSION,
  PieWorkspaceContextSchema,
  type PieWorkspaceContext
} from '../../../../shared/pie-workspace-context'

export type PieWorkspaceAccess = {
  context: PieWorkspaceContext
  canCreate: boolean
}

export type PieWorkspaceAccessFailure = 'project_required' | 'sign_in_required' | 'open_forbidden'

export function resolvePieWorkspaceAccess(
  item: {
    id: string
    identifier: string
    title: string
    projectId: string | null
    projectName?: string
  },
  session: PieSessionState
): PieWorkspaceAccess | PieWorkspaceAccessFailure {
  if (!item.projectId) {
    return 'project_required'
  }
  if (session.status !== 'signed_in') {
    return 'sign_in_required'
  }
  if (!session.permissions.includes('workspace.open')) {
    return 'open_forbidden'
  }

  const context = PieWorkspaceContextSchema.safeParse({
    schemaVersion: PIE_WORKSPACE_CONTEXT_SCHEMA_VERSION,
    authority: 'pie',
    organizationId: session.organizationId,
    projectId: item.projectId,
    ...(item.projectName ? { projectName: item.projectName } : {}),
    workItemId: item.id,
    workItemIdentifier: item.identifier,
    workItemTitle: item.title
  })
  if (!context.success) {
    return 'project_required'
  }
  return {
    context: context.data,
    canCreate: session.permissions.includes('workspace.execute')
  }
}
