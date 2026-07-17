import { describe, expect, it } from 'vitest'
import { scanForSecrets } from './agent-content-secret-scan'

// SEC-003 unit coverage: each well-known secret shape is detected and redacted WHOLE, a benign
// string is not flagged (low false positives), an injected canary is caught, and scanning is
// deterministic. No matched secret text is ever exposed — only kinds + count + placeholders.

describe('scanForSecrets', () => {
  const cases: { name: string; text: string; kind: string }[] = [
    {
      name: 'AWS access-key id',
      text: 'key is AKIAIOSFODNN7EXAMPLE here',
      kind: 'aws-access-key'
    },
    {
      name: 'GitHub token',
      text: 'token=ghp_0123456789abcdefghij0123456789abcdef done',
      kind: 'github-token'
    },
    {
      name: 'Slack token',
      text: 'xoxb-123456789012-abcdefghijkl now',
      kind: 'slack-token'
    },
    {
      name: 'JWT',
      text: 'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w end',
      kind: 'jwt'
    },
    {
      name: 'Bearer token',
      text: 'Authorization: Bearer abc123.def456-ghi789 trailing',
      kind: 'bearer'
    },
    {
      name: 'env-secret assignment',
      text: 'PASSWORD=hunter2supersecret rest',
      kind: 'env-secret'
    }
  ]

  it.each(cases)('detects and redacts $name whole', ({ text, kind }) => {
    const scan = scanForSecrets(text)
    expect(scan.hasSecret).toBe(true)
    expect(scan.kinds).toContain(kind)
    const redacted = scan.redact(text)
    expect(redacted).toContain(`‹redacted:${kind}›`)
    // Whole-match: no fragment of the secret survives.
    expect(redacted).not.toMatch(/AKIA|ghp_|xox|eyJ|hunter2|abc123\.def456/)
  })

  it('redacts a multi-line PEM private-key block whole', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34\nGkx...lines...\n-----END RSA PRIVATE KEY-----'
    const scan = scanForSecrets(`prefix ${pem} suffix`)
    expect(scan.kinds).toContain('pem-private-key')
    const redacted = scan.redact(`prefix ${pem} suffix`)
    expect(redacted).toBe('prefix ‹redacted:pem-private-key› suffix')
  })

  it('does not flag a benign string (low false positives)', () => {
    const scan = scanForSecrets('The quick brown fox reads 42 files at /home/user/project.')
    expect(scan.hasSecret).toBe(false)
    expect(scan.kinds).toEqual([])
    expect(scan.count).toBe(0)
    expect(scan.redact('unchanged text')).toBe('unchanged text')
  })

  it('catches an injected deny/canary entry and wins over shapes', () => {
    const scan = scanForSecrets('the canary CANARY-9c3f is present', { deny: ['CANARY-9c3f'] })
    expect(scan.hasSecret).toBe(true)
    expect(scan.kinds).toContain('deny')
    expect(scan.redact('the canary CANARY-9c3f is present')).toBe(
      'the canary ‹redacted:deny› is present'
    )
  })

  it('opt-in entropy heuristic is OFF by default and detectable when enabled', () => {
    const token = 'Zx9Qm2Vt7Kp4Lr8Nf1Wc6Yb3Hd5Gj0Ts8Ua2Ei4Ov7Pn9Rl3' // 50 chars, mixed
    expect(scanForSecrets(token).hasSecret).toBe(false)
    expect(scanForSecrets(token, { entropy: true }).kinds).toContain('high-entropy')
  })

  it('is deterministic: same input yields same kinds and count', () => {
    const text = 'AKIAIOSFODNN7EXAMPLE and PASSWORD=abc123def and AKIAIOSFODNN7EXAMPLE2X'
    const a = scanForSecrets(text)
    const b = scanForSecrets(text)
    expect(a.kinds).toEqual(b.kinds)
    expect(a.count).toBe(b.count)
    expect(a.redact(text)).toBe(b.redact(text))
  })
})
