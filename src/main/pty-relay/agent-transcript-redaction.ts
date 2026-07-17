// CAP-002 LOCAL redaction. Pure and deterministic: it scans transcript text for
// secret-shaped substrings and replaces each whole match with a stable
// placeholder BEFORE the record ever leaves the host (before the E2EE seal), so
// neither the relay, its logs, nor another viewer — nor even the ciphertext —
// ever carries the secret. No external I/O, no clock, no RNG: same input always
// yields the same output and count.

export type RedactionKind =
  | 'deny'
  | 'pem-private-key'
  | 'aws-access-key'
  | 'github-token'
  | 'slack-token'
  | 'jwt'
  | 'bearer'
  | 'env-secret'
  | 'high-entropy'

export type RedactionOptions = {
  // Caller-supplied canary / deny list (e.g. a seeded secret or known credential).
  // Each entry is matched literally and redacted whole. Highest priority.
  deny?: readonly string[]
  // Opt-in Shannon-entropy heuristic for long, high-entropy tokens. Off by default
  // to keep false positives low and the default behavior obviously deterministic.
  entropy?: boolean
}

export type RedactionResult = {
  text: string
  redactionCount: number
}

const placeholder = (kind: RedactionKind): string => `‹redacted:${kind}›`

// Structured secret shapes, applied in priority order. PEM blocks first (they are
// multi-line and would otherwise be partially caught by narrower rules), then the
// specific credential shapes, then generic KEY=value assignments.
const STRUCTURED_PATTERNS: readonly { kind: RedactionKind; pattern: RegExp }[] = [
  {
    kind: 'pem-private-key',
    // Whole PEM private-key block, header to footer, across newlines.
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
    // .env-style assignment whose KEY name signals a secret. The WHOLE assignment
    // (key and value) is redacted so no fragment of the value survives.
    pattern:
      /\b[A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi
  }
]

// Long candidate tokens for the optional entropy heuristic. Guillemets in the
// placeholder are non-ASCII, so an already-redacted span can never re-match.
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

export function redactTranscriptText(
  text: string,
  options: RedactionOptions = {}
): RedactionResult {
  let redactionCount = 0
  let result = text

  const applyPattern = (kind: RedactionKind, pattern: RegExp): void => {
    result = result.replace(pattern, () => {
      redactionCount += 1
      return placeholder(kind)
    })
  }

  // Deny list first: a caller canary must win even if it also matches a shape.
  const denyEntries = (options.deny ?? []).filter((entry) => entry.length > 0)
  if (denyEntries.length > 0) {
    const denyPattern = new RegExp(denyEntries.map(escapeForRegex).join('|'), 'g')
    applyPattern('deny', denyPattern)
  }

  for (const { kind, pattern } of STRUCTURED_PATTERNS) {
    applyPattern(kind, pattern)
  }

  if (options.entropy) {
    result = result.replace(HIGH_ENTROPY_CANDIDATE, (match) => {
      if (shannonBitsPerChar(match) >= HIGH_ENTROPY_MIN_BITS) {
        redactionCount += 1
        return placeholder('high-entropy')
      }
      return match
    })
  }

  return { text: result, redactionCount }
}
