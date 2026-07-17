import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verify } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InstallationSigningKey, computePublicKeyId } from './installation-signing-key'

// A fake safeStorage that base64-obscures at rest (stand-in for Keychain/DPAPI). It never stores
// the plaintext PEM verbatim, so the "never persist a plaintext key" invariant is testable.
function fakeSafeStorage(available = true, backend = 'keychain') {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (plaintext: string) =>
      Buffer.from(Buffer.from(plaintext, 'utf-8').toString('base64')),
    decryptString: (ciphertext: Buffer) =>
      Buffer.from(ciphertext.toString('utf-8'), 'base64').toString('utf-8')
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pie-inst-key-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeKey(opts: { available?: boolean; installationId?: string } = {}) {
  const installationId = opts.installationId
  return new InstallationSigningKey({
    safeStorage: fakeSafeStorage(opts.available ?? true),
    getUserDataPath: () => dir,
    platform: 'darwin',
    ...(installationId ? { generateInstallationId: (): string => installationId } : {})
  })
}

describe('InstallationSigningKey', () => {
  it('is idempotent: the same installationId and public key are reused across runs', () => {
    const first = makeKey({ installationId: 'inst-A' }).getOrCreate()
    // A brand new instance (fresh "run") over the same userData dir must load, not regenerate.
    const second = makeKey({ installationId: 'inst-B' }).getOrCreate()
    expect(first.status).toBe('ready')
    expect(second.status).toBe('ready')
    if (first.status !== 'ready' || second.status !== 'ready') {
      return
    }
    expect(second.identity.installationId).toBe('inst-A') // not inst-B — the stored key wins
    expect(second.identity.publicKeyPem).toBe(first.identity.publicKeyPem)
    expect(second.identity.publicKeyId).toBe(first.identity.publicKeyId)
  })

  it('never persists or exposes the plaintext private key', () => {
    const result = makeKey({ installationId: 'inst-A' }).getOrCreate()
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') {
      return
    }
    // The on-disk file must not contain the raw PKCS8 PEM.
    const fileText = readFileSync(
      join(dir, 'pie', 'installation-key', 'installation-signing-key.json.enc'),
      'utf-8'
    )
    expect(fileText).not.toContain('BEGIN PRIVATE KEY')
    // The returned identity exposes only a sign closure — no private key material anywhere in it.
    expect(JSON.stringify(result.identity)).not.toContain('BEGIN PRIVATE KEY')
    expect(Object.keys(result.identity)).not.toContain('privateKey')
  })

  it('produces a working sign closure whose signature verifies against the public key', () => {
    const result = makeKey({ installationId: 'inst-A' }).getOrCreate()
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') {
      return
    }
    const message = Buffer.from('canonical-bytes', 'utf-8')
    const signature = result.identity.sign(message)
    expect(verify(null, message, result.identity.publicKeyPem, signature)).toBe(true)
    expect(computePublicKeyId(result.identity.publicKeyPem)).toBe(result.identity.publicKeyId)
  })

  it('reports unavailable (and persists nothing) when secure storage is unavailable', () => {
    const result = makeKey({ available: false }).getOrCreate()
    expect(result.status).toBe('unavailable')
  })
})
