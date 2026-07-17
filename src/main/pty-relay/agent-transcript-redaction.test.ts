import { describe, expect, test } from 'vitest'
import { redactTranscriptText } from './agent-transcript-redaction'

describe('redactTranscriptText', () => {
  test('redacts common credential shapes whole, leaving no fragment', () => {
    const aws = redactTranscriptText('key is AKIAIOSFODNN7EXAMPLE here')
    expect(aws.text).toBe('key is ‹redacted:aws-access-key› here')
    expect(aws.redactionCount).toBe(1)

    const gh = redactTranscriptText('token ghp_0123456789abcdefghijklmnopqrstuvwxyz done')
    expect(gh.text).toContain('‹redacted:github-token›')
    expect(gh.text).not.toContain('ghp_0123456789')

    const slack = redactTranscriptText(['xoxb', '1234567890', 'abcdefghijklmno'].join('-'))
    expect(slack.text).toBe('‹redacted:slack-token›')

    const bearer = redactTranscriptText('Authorization: Bearer abc.DEF-123_456')
    expect(bearer.text).toBe('Authorization: ‹redacted:bearer›')

    const jwt = redactTranscriptText('eyJhbGc.eyJzdWIiOiIx.SflKxwRJSM')
    expect(jwt.text).toBe('‹redacted:jwt›')
  })

  test('redacts a PEM private-key block across newlines', () => {
    const pem =
      'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\nsecretline\n-----END RSA PRIVATE KEY-----\nafter'
    const result = redactTranscriptText(pem)
    expect(result.text).toBe('before\n‹redacted:pem-private-key›\nafter')
    expect(result.text).not.toContain('secretline')
    expect(result.redactionCount).toBe(1)
  })

  test('redacts .env-style secret assignments whole (key and value)', () => {
    const result = redactTranscriptText('AWS_SECRET_ACCESS_KEY=abc123XYZ+/def')
    expect(result.text).toBe('‹redacted:env-secret›')
    expect(result.text).not.toContain('abc123XYZ')
  })

  test('redacts a caller-supplied canary / deny entry', () => {
    const result = redactTranscriptText('the canary is CANARY-7f3a in the prompt', {
      deny: ['CANARY-7f3a']
    })
    expect(result.text).toBe('the canary is ‹redacted:deny› in the prompt')
    expect(result.redactionCount).toBe(1)
  })

  test('optional entropy heuristic catches a long high-entropy token, off by default', () => {
    const token = 'Zk9x2Qp7Lm4Rt8Vw1Nb6Hc3Jd5Ye0Fg2Ss4Tu7Wx9Yz1Ab'
    expect(redactTranscriptText(token).text).toBe(token) // off by default
    const on = redactTranscriptText(token, { entropy: true })
    expect(on.text).toBe('‹redacted:high-entropy›')
  })

  test('is deterministic: same input yields identical text and count', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE and ghp_0123456789abcdefghijklmnopqrstuvwxyz'
    const a = redactTranscriptText(input)
    const b = redactTranscriptText(input)
    expect(a).toEqual(b)
    expect(a.redactionCount).toBe(2)
  })

  test('leaves clean text untouched', () => {
    const clean = 'the quick brown fox ran 42 miles'
    const result = redactTranscriptText(clean)
    expect(result.text).toBe(clean)
    expect(result.redactionCount).toBe(0)
  })
})
