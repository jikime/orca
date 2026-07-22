import { describe, expect, it } from 'vitest'
import { buildWorkItemListPath } from './use-work-item-board'

describe('buildWorkItemListPath', () => {
  it('builds the organization work list without optional filters', () => {
    expect(buildWorkItemListPath({})).toBe('/work-items')
  })

  it('keeps My Work and project filters in one server query', () => {
    expect(
      buildWorkItemListPath({
        projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        assignee: 'me'
      })
    ).toBe('/work-items?projectId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&assignee=me')
  })
})
