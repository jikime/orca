import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFile } from '../../shared/secure-file'
import {
  getPieSecureStorageAvailability,
  type PieSafeStorageLike
} from './safe-storage-availability'
import {
  PieSessionSecretSchema,
  PieSessionSecretScopeSchema,
  pieSessionSecretScopeSegment,
  type PieSessionSecret,
  type PieSessionSecretReadResult,
  type PieSessionSecretSaveResult,
  type PieSessionSecretScope,
  type SessionSecretStore
} from './session-secret-store'

const PIE_SESSION_SECRET_FILE = 'refresh-token.json.enc'

type PersistedPieSessionSecret = {
  version: 1
  format: 'electron-safe-storage-v1'
  ciphertext: string
}

function isPersistedPieSessionSecret(value: unknown): value is PersistedPieSessionSecret {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    candidate.version === 1 &&
    candidate.format === 'electron-safe-storage-v1' &&
    typeof candidate.ciphertext === 'string' &&
    candidate.ciphertext.length > 0
  )
}

export type SafeStorageSessionSecretStoreOptions = {
  safeStorage: PieSafeStorageLike & {
    encryptString: (plaintext: string) => Buffer
    decryptString: (ciphertext: Buffer) => string
  }
  getUserDataPath: () => string
  platform?: NodeJS.Platform
}

export class SafeStorageSessionSecretStore implements SessionSecretStore {
  readonly #options: SafeStorageSessionSecretStoreOptions

  constructor(options: SafeStorageSessionSecretStoreOptions) {
    this.#options = options
  }

  accountDirectory(scope: PieSessionSecretScope): string {
    const parsed = PieSessionSecretScopeSchema.parse(scope)
    return join(
      this.#options.getUserDataPath(),
      'pie',
      'session-secrets',
      pieSessionSecretScopeSegment(parsed.instanceId),
      pieSessionSecretScopeSegment(parsed.profileId),
      pieSessionSecretScopeSegment(parsed.accountId)
    )
  }

  secretPath(scope: PieSessionSecretScope): string {
    return join(this.accountDirectory(scope), PIE_SESSION_SECRET_FILE)
  }

  save(scope: PieSessionSecretScope, secret: PieSessionSecret): PieSessionSecretSaveResult {
    const availability = this.#availability()
    if (!availability.available) {
      return { status: 'persistent-login-unavailable', reason: availability.reason }
    }
    const parsedSecret = PieSessionSecretSchema.parse(secret)
    const persisted: PersistedPieSessionSecret = {
      version: 1,
      format: 'electron-safe-storage-v1',
      ciphertext: this.#options.safeStorage
        .encryptString(JSON.stringify(parsedSecret))
        .toString('base64')
    }
    // Why: scope validation must throw (programming error), while disk failures
    // below degrade to memory-only. Resolve the path before the write guard.
    const path = this.secretPath(scope)
    try {
      writeSecureJsonFile(path, persisted)
      return { status: 'persisted' }
    } catch {
      // Why: a failed disk write must not crash sign-in, and the error must not
      // carry token material into logs. The session stays memory-only.
      return { status: 'persistent-login-unavailable', reason: 'write-failed' }
    }
  }

  read(scope: PieSessionSecretScope): PieSessionSecretReadResult {
    const availability = this.#availability()
    if (!availability.available) {
      return { status: 'persistent-login-unavailable', reason: availability.reason }
    }
    const path = this.secretPath(scope)
    if (!existsSync(path)) {
      return { status: 'missing' }
    }
    try {
      const persisted: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      if (!isPersistedPieSessionSecret(persisted)) {
        return this.#discardCorrupt(path)
      }
      const decrypted = this.#options.safeStorage.decryptString(
        Buffer.from(persisted.ciphertext, 'base64')
      )
      const secret = PieSessionSecretSchema.safeParse(JSON.parse(decrypted))
      if (!secret.success) {
        return this.#discardCorrupt(path)
      }
      return { status: 'found', secret: secret.data }
    } catch {
      return this.#discardCorrupt(path)
    }
  }

  delete(scope: PieSessionSecretScope): void {
    rmSync(this.secretPath(scope), { force: true })
  }

  clearAccount(scope: PieSessionSecretScope): void {
    rmSync(this.accountDirectory(scope), { force: true, recursive: true })
  }

  #availability(): ReturnType<typeof getPieSecureStorageAvailability> {
    return getPieSecureStorageAvailability(
      this.#options.safeStorage,
      this.#options.platform ?? process.platform
    )
  }

  #discardCorrupt(path: string): PieSessionSecretReadResult {
    // Why: undecryptable or malformed ciphertext is unrecoverable; keeping the
    // file would retry-fail forever. Discarding forces a clean re-login.
    rmSync(path, { force: true })
    return { status: 'discarded-corrupt' }
  }
}
