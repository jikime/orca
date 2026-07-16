import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SafeStorageSessionSecretStore } from './safe-storage-session-secret-store'
import type { PieSessionSecretScope } from './session-secret-store'

const REFRESH_TOKEN = 'pie-refresh-token-b2c1a55e-secret-value'

// Why: XOR keeps the fake reversible while guaranteeing ciphertext bytes never
// contain the plaintext token, so the on-disk leak assertions are meaningful.
function xorBuffer(input: Buffer): Buffer {
  return Buffer.from(input.map((byte) => byte ^ 0x5a))
}

function fakeSafeStorage(options: { encryptionAvailable?: boolean; backend?: string } = {}): {
  isEncryptionAvailable: () => boolean
  getSelectedStorageBackend?: () => string
  encryptString: (plaintext: string) => Buffer
  decryptString: (ciphertext: Buffer) => string
} {
  return {
    isEncryptionAvailable: () => options.encryptionAvailable ?? true,
    ...(options.backend === undefined
      ? {}
      : { getSelectedStorageBackend: () => options.backend as string }),
    encryptString: (plaintext: string) => xorBuffer(Buffer.from(plaintext, 'utf-8')),
    decryptString: (ciphertext: Buffer) => {
      const decrypted = xorBuffer(ciphertext).toString('utf-8')
      if (!decrypted.startsWith('{')) {
        throw new Error('decryption failed')
      }
      return decrypted
    }
  }
}

const scope: PieSessionSecretScope = {
  instanceId: 'local-desktop',
  profileId: 'profile-alpha',
  accountId: '0f0e0d0c-0b0a-4a4b-8c8d-1a2b3c4d5e6f'
}

let userDataPath = ''

function makeStore(
  options: { encryptionAvailable?: boolean; backend?: string; platform?: NodeJS.Platform } = {}
): SafeStorageSessionSecretStore {
  return new SafeStorageSessionSecretStore({
    safeStorage: fakeSafeStorage(options),
    getUserDataPath: () => userDataPath,
    platform: options.platform ?? 'darwin'
  })
}

function listFilesRecursively(directory: string): string[] {
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'pie-secret-store-'))
})

afterEach(() => {
  rmSync(userDataPath, { force: true, recursive: true })
})

describe('SafeStorageSessionSecretStore', () => {
  it('round-trips a refresh token without writing plaintext to disk', () => {
    const store = makeStore()
    expect(store.save(scope, { refreshToken: REFRESH_TOKEN, savedAt: 1_000 })).toEqual({
      status: 'persisted'
    })

    const files = listFilesRecursively(userDataPath)
    expect(files).toHaveLength(1)
    for (const file of files) {
      const raw = readFileSync(file)
      expect(raw.includes(REFRESH_TOKEN)).toBe(false)
      expect(raw.includes(Buffer.from(REFRESH_TOKEN, 'utf-8').toString('base64'))).toBe(false)
    }

    expect(store.read(scope)).toEqual({
      status: 'found',
      secret: { refreshToken: REFRESH_TOKEN, savedAt: 1_000 }
    })
  })

  it('restricts the secret file permissions on POSIX', () => {
    const store = makeStore()
    store.save(scope, { refreshToken: REFRESH_TOKEN, savedAt: 1 })
    if (process.platform !== 'win32') {
      expect(statSync(store.secretPath(scope)).mode & 0o777).toBe(0o600)
    }
  })

  it('reports missing before any save and after delete', () => {
    const store = makeStore()
    expect(store.read(scope)).toEqual({ status: 'missing' })
    store.save(scope, { refreshToken: REFRESH_TOKEN, savedAt: 1 })
    store.delete(scope)
    expect(store.read(scope)).toEqual({ status: 'missing' })
  })

  it('replaces the stored token on rotation-style saves', () => {
    const store = makeStore()
    store.save(scope, { refreshToken: 'first-token-value-123', savedAt: 1 })
    store.save(scope, { refreshToken: 'second-token-value-456', savedAt: 2 })
    expect(store.read(scope)).toEqual({
      status: 'found',
      secret: { refreshToken: 'second-token-value-456', savedAt: 2 }
    })
    for (const file of listFilesRecursively(userDataPath)) {
      expect(readFileSync(file).includes('first-token-value-123')).toBe(false)
    }
  })

  it('isolates secrets across instance, profile, and account', () => {
    const store = makeStore()
    const otherInstance = { ...scope, instanceId: 'saas.pielab.ai' }
    const otherProfile = { ...scope, profileId: 'profile-beta' }
    const otherAccount = { ...scope, accountId: '9f9e9d9c-9b9a-4a4b-8c8d-6f5e4d3c2b1a' }
    store.save(scope, { refreshToken: 'token-scope-main', savedAt: 1 })
    store.save(otherInstance, { refreshToken: 'token-other-instance', savedAt: 2 })
    store.save(otherProfile, { refreshToken: 'token-other-profile', savedAt: 3 })
    store.save(otherAccount, { refreshToken: 'token-other-account', savedAt: 4 })

    expect(store.read(scope)).toMatchObject({ secret: { refreshToken: 'token-scope-main' } })
    expect(store.read(otherInstance)).toMatchObject({
      secret: { refreshToken: 'token-other-instance' }
    })
    expect(store.read(otherProfile)).toMatchObject({
      secret: { refreshToken: 'token-other-profile' }
    })
    expect(store.read(otherAccount)).toMatchObject({
      secret: { refreshToken: 'token-other-account' }
    })

    store.delete(scope)
    expect(store.read(scope)).toEqual({ status: 'missing' })
    expect(store.read(otherInstance).status).toBe('found')
    expect(store.read(otherProfile).status).toBe('found')
    expect(store.read(otherAccount).status).toBe('found')
  })

  it('separates IDs that only differ by case', () => {
    const store = makeStore()
    const upper = { ...scope, profileId: 'Profile-Alpha' }
    store.save(scope, { refreshToken: 'token-lower-case', savedAt: 1 })
    store.save(upper, { refreshToken: 'token-upper-case', savedAt: 2 })
    expect(store.read(scope)).toMatchObject({ secret: { refreshToken: 'token-lower-case' } })
    expect(store.read(upper)).toMatchObject({ secret: { refreshToken: 'token-upper-case' } })
  })

  it('clearAccount removes the whole account area but not sibling accounts', () => {
    const store = makeStore()
    const otherAccount = { ...scope, accountId: '9f9e9d9c-9b9a-4a4b-8c8d-6f5e4d3c2b1a' }
    store.save(scope, { refreshToken: 'token-scope-main', savedAt: 1 })
    store.save(otherAccount, { refreshToken: 'token-other-account', savedAt: 2 })

    store.clearAccount(scope)
    expect(existsSync(store.accountDirectory(scope))).toBe(false)
    expect(store.read(scope)).toEqual({ status: 'missing' })
    expect(store.read(otherAccount).status).toBe('found')
  })

  it('rejects scope IDs that could escape the storage directory', () => {
    const store = makeStore()
    expect(() =>
      store.save({ ...scope, profileId: '../escape' }, { refreshToken: REFRESH_TOKEN, savedAt: 1 })
    ).toThrow()
    expect(listFilesRecursively(userDataPath)).toHaveLength(0)
  })

  it('discards corrupted ciphertext and forces re-login', () => {
    const store = makeStore()
    store.save(scope, { refreshToken: REFRESH_TOKEN, savedAt: 1 })
    const path = store.secretPath(scope)
    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as { ciphertext: string }
    persisted.ciphertext = Buffer.from('corrupted-bytes', 'utf-8').toString('base64')
    writeFileSync(path, JSON.stringify(persisted), 'utf-8')

    expect(store.read(scope)).toEqual({ status: 'discarded-corrupt' })
    expect(existsSync(path)).toBe(false)
    expect(store.read(scope)).toEqual({ status: 'missing' })
  })

  it('discards files with an unexpected format instead of trusting them', () => {
    const store = makeStore()
    store.save(scope, { refreshToken: REFRESH_TOKEN, savedAt: 1 })
    const path = store.secretPath(scope)
    writeFileSync(
      path,
      JSON.stringify({ version: 1, format: 'dev-plaintext-v1', refreshToken: REFRESH_TOKEN }),
      'utf-8'
    )
    expect(store.read(scope)).toEqual({ status: 'discarded-corrupt' })
    expect(existsSync(path)).toBe(false)
  })

  it('disables persistent login when no secure backend exists, without writing', () => {
    const store = makeStore({ encryptionAvailable: false })
    expect(store.save(scope, { refreshToken: REFRESH_TOKEN, savedAt: 1 })).toEqual({
      status: 'persistent-login-unavailable',
      reason: 'encryption-unavailable'
    })
    expect(listFilesRecursively(userDataPath)).toHaveLength(0)
    expect(store.read(scope)).toEqual({
      status: 'persistent-login-unavailable',
      reason: 'encryption-unavailable'
    })
  })

  it('refuses the Linux basic_text backend for both save and read', () => {
    const store = makeStore({ backend: 'basic_text', platform: 'linux' })
    expect(store.save(scope, { refreshToken: REFRESH_TOKEN, savedAt: 1 })).toEqual({
      status: 'persistent-login-unavailable',
      reason: 'linux-basic-text-backend'
    })
    expect(listFilesRecursively(userDataPath)).toHaveLength(0)
    expect(store.read(scope)).toEqual({
      status: 'persistent-login-unavailable',
      reason: 'linux-basic-text-backend'
    })
  })

  it('persists normally on a Linux Secret Service backend', () => {
    const store = makeStore({ backend: 'gnome_libsecret', platform: 'linux' })
    expect(store.save(scope, { refreshToken: REFRESH_TOKEN, savedAt: 1 })).toEqual({
      status: 'persisted'
    })
    expect(store.read(scope)).toMatchObject({ status: 'found' })
  })
})
