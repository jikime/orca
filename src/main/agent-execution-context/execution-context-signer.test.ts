import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeExecutionContext,
  type ExecutionContext,
  type SignedExecutionContext
} from '../../shared/execution-context-contract'
import { computePublicKeyId, type InstallationSigningIdentity } from './installation-signing-key'
import {
  buildSignedExecutionContext,
  normalizeWorkspacePathForHost
} from './execution-context-signer'

// A signing identity backed by an in-test Ed25519 keypair (no disk, no safeStorage needed here).
function testIdentity(installationId = 'inst-1'): InstallationSigningIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
  return {
    installationId,
    publicKeyPem,
    publicKeyId: computePublicKeyId(publicKeyPem),
    sign: (bytes: Buffer) => sign(null, bytes, privateKey)
  }
}

const base = {
  hostType: 'native' as const,
  hostId: 'host-1',
  workspacePath: '/Users/dev/projects/orca',
  osUser: 'dev',
  launchId: 'launch-1',
  agentSessionId: 'session-1',
  provider: 'claude_code',
  nowMs: 1_750_000_000_000,
  ttlMs: 900_000,
  platform: 'darwin' as NodeJS.Platform
}

describe('buildSignedExecutionContext', () => {
  it('signs the canonical bytes with a validity window; the signature verifies', () => {
    const identity = testIdentity()
    const signed = buildSignedExecutionContext({ identity, ...base })
    expect(signed.context.notBefore).toBe(base.nowMs)
    expect(signed.context.notAfter).toBe(base.nowMs + base.ttlMs)
    const bytes = Buffer.from(canonicalizeExecutionContext(signed.context), 'utf-8')
    expect(
      verify(null, bytes, identity.publicKeyPem, Buffer.from(signed.signature, 'base64'))
    ).toBe(true)
    expect(signed.publicKeyId).toBe(identity.publicKeyId)
    expect(signed.installationId).toBe(identity.installationId)
  })

  it('is deterministic: identical inputs + clock produce identical canonical bytes and signature', () => {
    const identity = testIdentity()
    const a = buildSignedExecutionContext({ identity, ...base })
    const b = buildSignedExecutionContext({ identity, ...base })
    expect(canonicalizeExecutionContext(a.context)).toBe(canonicalizeExecutionContext(b.context))
    expect(a.signature).toBe(b.signature) // Ed25519 is deterministic
  })

  it('normalizes workspacePath per host so the same path forks by host TYPE', () => {
    expect(normalizeWorkspacePathForHost('native', '/a/b/../c', 'darwin')).toBe('/a/c')
    expect(normalizeWorkspacePathForHost('wsl', '/home/u/./proj', 'win32')).toBe('/home/u/proj')
    // Windows native upper-cases the drive so casing never forks a bind.
    expect(normalizeWorkspacePathForHost('native', 'c:\\Users\\Dev', 'win32')).toBe(
      'C:\\Users\\Dev'
    )
  })
})

describe('shared golden signed-context fixture (cross-workspace canonical agreement)', () => {
  it('reproduces the golden canonical bytes and verifies the golden signature', () => {
    // Resolve repo root from this test file (src/main/agent-execution-context → up 3).
    const goldenPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'contracts',
      'golden',
      'execution-context-signed.golden.json'
    )
    const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as {
      canonicalBytes: string
      publicKeyPem: string
      signed: SignedExecutionContext
    }
    const context = golden.signed.context as ExecutionContext
    expect(canonicalizeExecutionContext(context)).toBe(golden.canonicalBytes)
    expect(
      verify(
        null,
        Buffer.from(golden.canonicalBytes, 'utf-8'),
        createPublicKey(golden.publicKeyPem),
        Buffer.from(golden.signed.signature, 'base64')
      )
    ).toBe(true)
  })
})
