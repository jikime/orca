import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeExecutionContext,
  type SignedExecutionContext
} from './execution-context-canonical'

// R5 s2b cross-workspace agreement: the platform canonical mirror must reproduce the shared golden
// byte-for-byte, and the golden signature must verify against the golden public key. If the client
// and platform serializers ever drift, one of these two assertions fails on BOTH sides.
type Golden = {
  canonicalBytes: string
  publicKeyPem: string
  signed: SignedExecutionContext
}

// vitest runs with process.cwd() == platform/; the golden lives at repo-root contracts/golden.
const GOLDEN_PATH = join(
  process.cwd(),
  '..',
  'contracts',
  'golden',
  'execution-context-signed.golden.json'
)

describe('execution-context canonical golden (R5 s2b)', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as Golden

  it('reproduces the shared canonicalBytes byte-for-byte', () => {
    expect(canonicalizeExecutionContext(golden.signed.context)).toBe(golden.canonicalBytes)
  })

  it('verifies the golden signature against the golden public key', () => {
    const verified = cryptoVerify(
      null,
      Buffer.from(golden.canonicalBytes, 'utf8'),
      createPublicKey(golden.publicKeyPem),
      Buffer.from(golden.signed.signature, 'base64')
    )
    expect(verified).toBe(true)
  })
})
