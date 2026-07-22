import { describe, expect, it } from 'vitest'
import { WorktreeActivate, WorktreeCreate } from './worktree-schemas'

describe('worktree RPC schemas', () => {
  it('validates additive navigation intent', () => {
    expect(WorktreeActivate.parse({ worktree: 'id:wt-1', navigation: 'clients' }).navigation).toBe(
      'clients'
    )
    expect(
      WorktreeActivate.safeParse({ worktree: 'id:wt-1', navigation: 'everyone' }).success
    ).toBe(false)
  })

  it('rejects invalid startup agent values', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupAgent: 'wat',
      startupPrompt: 'hi'
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects startup prompts without startup agents', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupPrompt: 'hi'
    })

    expect(parsed.success).toBe(false)
  })

  it('validates Pie workspace context at the runtime boundary', () => {
    const context = {
      schemaVersion: 1,
      authority: 'pie',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workItemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      workItemIdentifier: 'APP-142',
      workItemTitle: 'Fix login error'
    }

    expect(
      WorktreeCreate.safeParse({ repo: 'repo-1', name: 'pie-work', pieWorkspaceContext: context })
        .success
    ).toBe(true)
    expect(
      WorktreeCreate.safeParse({
        repo: 'repo-1',
        name: 'pie-work',
        pieWorkspaceContext: { ...context, organizationId: 'another-tenant' }
      }).success
    ).toBe(false)
  })
})
