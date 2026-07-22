import { describe, expect, it } from 'vitest'
import {
  isSamePieWorkspaceContext,
  parsePieWorkspaceContext,
  PIE_WORKSPACE_CONTEXT_SCHEMA_VERSION
} from './pie-workspace-context'

const context = {
  schemaVersion: PIE_WORKSPACE_CONTEXT_SCHEMA_VERSION,
  authority: 'pie' as const,
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workItemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workItemIdentifier: 'APP-142',
  workItemTitle: 'Fix login error'
}

describe('PieWorkspaceContext', () => {
  it('accepts a tenant-scoped Pie WorkItem context', () => {
    expect(parsePieWorkspaceContext(context)).toEqual(context)
  })

  it('does not accept external provider metadata as a Pie context', () => {
    expect(
      parsePieWorkspaceContext({
        ...context,
        authority: 'linear',
        provider: 'linear'
      })
    ).toBeNull()
  })

  it('requires a project before a WorkItem can launch a Workspace', () => {
    expect(parsePieWorkspaceContext({ ...context, projectId: null })).toBeNull()
  })

  it('compares opaque identity within its organization boundary', () => {
    const renamed = { ...context, workItemTitle: 'Renamed' }
    expect(isSamePieWorkspaceContext(context, renamed)).toBe(true)
    expect(
      isSamePieWorkspaceContext(context, {
        ...context,
        organizationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      })
    ).toBe(false)
  })
})
