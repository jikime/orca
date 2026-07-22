import { describe, expect, it } from 'vitest'
import { resolvePieWorkspaceAccess } from './pie-workspace-access'

const item = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  identifier: 'APP-142',
  title: 'Fix login error',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  projectName: 'Orca desktop'
}

const session = {
  status: 'signed_in' as const,
  instanceId: 'local-desktop',
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'Tester',
  organizationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  permissions: ['workspace.open', 'workspace.execute'],
  expiresAt: '2026-07-21T00:00:00.000Z'
}

describe('resolvePieWorkspaceAccess', () => {
  it('builds a tenant-scoped context and reports create permission', () => {
    expect(resolvePieWorkspaceAccess(item, session)).toEqual({
      context: {
        schemaVersion: 1,
        authority: 'pie',
        organizationId: session.organizationId,
        projectId: item.projectId,
        projectName: item.projectName,
        workItemId: item.id,
        workItemIdentifier: item.identifier,
        workItemTitle: item.title
      },
      canCreate: true
    })
  })

  it('requires a project and an authenticated workspace.open grant', () => {
    expect(resolvePieWorkspaceAccess({ ...item, projectId: null }, session)).toBe(
      'project_required'
    )
    expect(
      resolvePieWorkspaceAccess(item, { status: 'signed_out', instanceId: 'local-desktop' })
    ).toBe('sign_in_required')
    expect(resolvePieWorkspaceAccess(item, { ...session, permissions: [] })).toBe('open_forbidden')
  })
})
