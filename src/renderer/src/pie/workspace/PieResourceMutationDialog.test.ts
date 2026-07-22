import { describe, expect, it } from 'vitest'
import type { PieFieldSpec } from './pie-domain-types'
import { buildPieMutationBody } from './PieResourceMutationDialog'

const FIELDS: readonly PieFieldSpec[] = [
  { key: 'title', label: 'Title', required: true },
  { key: 'description', label: 'Description', type: 'textarea' },
  { key: 'scheduleDeltaDays', label: 'Schedule', type: 'number' }
]

describe('buildPieMutationBody', () => {
  it('omits empty optional values when creating a resource', () => {
    expect(
      buildPieMutationBody(
        FIELDS,
        { title: ' Release ', description: ' ', scheduleDeltaDays: '' },
        'create'
      )
    ).toEqual({ title: 'Release' })
  })

  it('clears optional values and converts numbers when editing a resource', () => {
    expect(
      buildPieMutationBody(
        FIELDS,
        { title: 'Release', description: '', scheduleDeltaDays: ' 5 ' },
        'edit'
      )
    ).toEqual({ title: 'Release', description: null, scheduleDeltaDays: 5 })
  })
})
