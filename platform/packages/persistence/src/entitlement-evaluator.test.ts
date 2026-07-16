import { describe, expect, it } from 'vitest'
import { evaluateEntitlement } from './entitlement-evaluator'

describe('entitlement evaluator', () => {
  it('allows a limit when usage + increment is within the grant', () => {
    expect(evaluateEntitlement({ enforcement: 'limit', grantValue: 50, currentUsage: 49 })).toEqual(
      {
        allowed: true,
        reason: 'allowed'
      }
    )
  })

  it('is a shortfall exactly at the boundary', () => {
    expect(evaluateEntitlement({ enforcement: 'limit', grantValue: 1, currentUsage: 1 })).toEqual({
      allowed: false,
      reason: 'entitlement_shortfall'
    })
  })

  it('treats a null limit as unlimited', () => {
    expect(
      evaluateEntitlement({ enforcement: 'limit', grantValue: null, currentUsage: 1_000_000 })
    ).toEqual({ allowed: true, reason: 'allowed' })
  })

  it('allows a boolean entitlement only when granted true', () => {
    expect(
      evaluateEntitlement({ enforcement: 'boolean', grantValue: true, currentUsage: 0 })
    ).toEqual({
      allowed: true,
      reason: 'allowed'
    })
    expect(
      evaluateEntitlement({ enforcement: 'boolean', grantValue: false, currentUsage: 0 })
    ).toEqual({
      allowed: false,
      reason: 'entitlement_shortfall'
    })
  })

  it('default-denies a missing/unknown limit grant', () => {
    expect(
      evaluateEntitlement({ enforcement: 'limit', grantValue: undefined as never, currentUsage: 0 })
    ).toEqual({ allowed: false, reason: 'entitlement_shortfall' })
  })
})
