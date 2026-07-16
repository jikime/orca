import { describe, expect, it } from 'vitest'
import { isPieInviteUrl, parsePieInviteUrl } from './pie-invite-link'

describe('pie://invite deep link', () => {
  it('parses a well-formed invite link', () => {
    const token = 'abcDEF012_-abcDEF012_-abcDEF012_-abcDEF01'
    const result = parsePieInviteUrl(`pie://invite/${token}`)
    expect(result).toEqual({ ok: true, token })
  })

  it('recognizes invite links vs auth callbacks', () => {
    expect(isPieInviteUrl('pie://invite/abc')).toBe(true)
    expect(isPieInviteUrl('pie://auth/callback?code=x&state=y')).toBe(false)
  })

  it('rejects a non-invite link', () => {
    expect(parsePieInviteUrl('pie://auth/callback?code=x')).toEqual({
      ok: false,
      reason: 'not-invite-link'
    })
  })

  it('rejects a malformed token (bad charset)', () => {
    expect(parsePieInviteUrl('pie://invite/has spaces!').ok).toBe(false)
    expect(parsePieInviteUrl('pie://invite/short').ok).toBe(false)
  })

  it('rejects query/fragment smuggling', () => {
    expect(parsePieInviteUrl('pie://invite/abcDEF012_-abcDEF012_?x=1').ok).toBe(false)
    expect(parsePieInviteUrl('pie://invite/abcDEF012_-abcDEF012_#frag').ok).toBe(false)
  })

  it('rejects an over-long url', () => {
    expect(parsePieInviteUrl(`pie://invite/${'a'.repeat(5000)}`).ok).toBe(false)
  })
})
