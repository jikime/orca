// R5 slice 5b (SEC-003): SERVER-SIDE CONTENT secret scanner. The R5 s5a redaction trusted the
// client-supplied `classification` label; a secret mislabeled `classification:public` was stored
// and returned/searched in cleartext. This module inspects the CONTENT itself so a secret is caught
// regardless of its declared label (content-floor-over-label). Pure and deterministic: no I/O, no
// clock, no RNG — the same input always yields the same matches, kinds, and redaction. It mirrors
// the well-known public secret shapes of the LOCAL client redactor (src/main/pty-relay,
// clean-room re-implementation) so a secret caught on the host is also caught server-side.
//
// The scanner NEVER logs or returns matched secret text: callers receive only the KINDS and a
// COUNT (audit-safe metadata) plus a `redact` closure that replaces each whole match with a stable
// placeholder — never a partial fragment of the secret.

export type SecretKind =
  | 'deny'
  | 'pem-private-key'
  | 'aws-access-key'
  | 'github-token'
  | 'slack-token'
  | 'jwt'
  | 'bearer'
  | 'env-secret'
  | 'high-entropy'

export type SecretScanOptions = {
  // Caller-supplied canary / deny list (e.g. a seeded secret or known credential). Each entry is
  // matched literally and redacted whole. Highest priority so a canary wins even if it also matches
  // a structured shape.
  deny?: readonly string[]
  // Opt-in Shannon-entropy heuristic for long, high-entropy tokens. OFF by default to bound false
  // positives and keep the default behavior obviously deterministic.
  entropy?: boolean
}

export type SecretScanResult = {
  hasSecret: boolean
  // Distinct kinds detected, sorted for determinism. Audit-safe: NEVER the secret text.
  kinds: SecretKind[]
  // Total number of whole matches redacted.
  count: number
  // Redacts a given text with the SAME patterns/deny-list this scan used. Deterministic; replaces
  // each whole match with `‹redacted:kind›` so no fragment of a secret survives.
  redact(text: string): string
}

const placeholder = (kind: SecretKind): string => `‹redacted:${kind}›`

// Structured secret shapes, applied in priority order. PEM blocks first (multi-line — a narrower
// rule would otherwise partially catch them), then specific credential shapes, then generic
// KEY=value assignments. Each pattern is global so every occurrence is redacted.
const STRUCTURED_PATTERNS: readonly { kind: SecretKind; pattern: RegExp }[] = [
  {
    kind: 'pem-private-key',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g
  },
  {
    kind: 'aws-access-key',
    // AWS access-key IDs (AKIA/ASIA/AGPA/AIDA...) are a fixed 20-char shape.
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g
  },
  {
    kind: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g
  },
  {
    kind: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
  },
  {
    kind: 'jwt',
    // JWT-ish: three base64url segments; the header segment begins with `eyJ`.
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
  },
  {
    kind: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g
  },
  {
    kind: 'env-secret',
    // KEY=value assignment whose KEY name signals a secret. The prefix is optional so a bare
    // `PASSWORD=...` is caught as well as `DB_PASSWORD=...`. The WHOLE assignment (key and value)
    // is redacted so no fragment of the value survives.
    // The value token excludes the placeholder guillemet `‹` so env-secret never re-consumes a span
    // an earlier structured rule already redacted (which would relabel a github/bearer/etc match).
    pattern:
      /\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s‹]+)/gi
  }
]

// Long candidate tokens for the optional entropy heuristic. Guillemets in the placeholder are
// non-ASCII, so an already-redacted span can never re-match.
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{40,}/g
const HIGH_ENTROPY_MIN_BITS = 4.0

function shannonBitsPerChar(token: string): number {
  const counts = new Map<string, number>()
  for (const char of token) {
    counts.set(char, (counts.get(char) ?? 0) + 1)
  }
  let bits = 0
  for (const count of counts.values()) {
    const p = count / token.length
    bits -= p * Math.log2(p)
  }
  return bits
}

function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One redaction pass. Returns the redacted text plus the distinct kinds and total match count.
// Never returns the matched text itself — only kinds + count (audit-safe).
function applyRedaction(
  text: string,
  options: SecretScanOptions
): { text: string; kinds: Set<SecretKind>; count: number } {
  let result = text
  let count = 0
  const kinds = new Set<SecretKind>()

  const applyPattern = (kind: SecretKind, pattern: RegExp): void => {
    result = result.replace(pattern, () => {
      count += 1
      kinds.add(kind)
      return placeholder(kind)
    })
  }

  // Deny list first: a caller canary must win even if it also matches a structured shape.
  const denyEntries = (options.deny ?? []).filter((entry) => entry.length > 0)
  if (denyEntries.length > 0) {
    applyPattern('deny', new RegExp(denyEntries.map(escapeForRegex).join('|'), 'g'))
  }

  for (const { kind, pattern } of STRUCTURED_PATTERNS) {
    applyPattern(kind, pattern)
  }

  if (options.entropy) {
    result = result.replace(HIGH_ENTROPY_CANDIDATE, (match) => {
      if (shannonBitsPerChar(match) >= HIGH_ENTROPY_MIN_BITS) {
        count += 1
        kinds.add('high-entropy')
        return placeholder('high-entropy')
      }
      return match
    })
  }

  return { text: result, kinds, count }
}

/**
 * Scans `text` for well-known secret shapes plus any injected deny/canary entries. Returns whether
 * a secret is present, the distinct kinds (sorted, audit-safe), the match count, and a `redact`
 * closure bound to the same options so callers can redact any text (the same payload, a preview, a
 * snippet) identically. Deterministic; never exposes the matched secret text.
 */
export function scanForSecrets(text: string, options: SecretScanOptions = {}): SecretScanResult {
  const scan = applyRedaction(text, options)
  return {
    hasSecret: scan.count > 0,
    kinds: [...scan.kinds].sort(),
    count: scan.count,
    redact: (input: string): string => applyRedaction(input, options).text
  }
}
