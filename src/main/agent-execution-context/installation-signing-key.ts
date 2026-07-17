import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign
} from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeSecureJsonFile } from '../../shared/secure-file'
import {
  getPieSecureStorageAvailability,
  type PieSafeStorageLike
} from '../pie-session/safe-storage-availability'

// R5 slice 2b: the per-installation Ed25519 signing key (doc 24 anti-forgery). The PRIVATE key is
// persisted encrypted at rest via Electron safeStorage (same pattern as the session secret store)
// and NEVER logged or exposed to preload/renderer; the PUBLIC key is exported for registration with
// the Control Plane, which is the trust bootstrap. Idempotent: one key per installation, reused
// across runs — a fresh key is minted only when none exists (or the stored one is unreadable).

const INSTALLATION_KEY_FILE = 'installation-signing-key.json.enc'
const INSTALLATION_KEY_DIR = ['pie', 'installation-key']

type PersistedInstallationKey = {
  version: 1
  format: 'electron-safe-storage-v1'
  installationId: string
  publicKeyPem: string
  // safeStorage-encrypted PKCS8 PEM of the Ed25519 private key, base64. Never logged.
  privateKeyCiphertext: string
}

function isPersistedInstallationKey(value: unknown): value is PersistedInstallationKey {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const c = value as Record<string, unknown>
  return (
    c.version === 1 &&
    c.format === 'electron-safe-storage-v1' &&
    typeof c.installationId === 'string' &&
    c.installationId.length > 0 &&
    typeof c.publicKeyPem === 'string' &&
    c.publicKeyPem.length > 0 &&
    typeof c.privateKeyCiphertext === 'string' &&
    c.privateKeyCiphertext.length > 0
  )
}

// The signing public-key fingerprint: base64url(sha256(SPKI DER)). Rotation-detectable and computed
// identically on the server from the registered key so a rotated key surfaces a distinct id.
export function computePublicKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' })
  return createHash('sha256').update(der).digest('base64url')
}

export type InstallationSigningIdentity = {
  installationId: string
  publicKeyPem: string
  publicKeyId: string
  // Signs the canonical execution-context bytes (Ed25519 needs no digest). The private key stays
  // captured in this closure — it is never returned, logged, or serialized.
  sign: (bytes: Buffer) => Buffer
}

export type InstallationSigningKeyResult =
  | { status: 'ready'; identity: InstallationSigningIdentity }
  // Secure storage is unavailable, so a stable private key cannot be persisted; signing is disabled
  // and the outbox falls back to identity-only ingest (local_observed) — never a plaintext key.
  | { status: 'unavailable'; reason: string }

export type InstallationSigningKeyOptions = {
  safeStorage: PieSafeStorageLike & {
    encryptString: (plaintext: string) => Buffer
    decryptString: (ciphertext: Buffer) => string
  }
  getUserDataPath: () => string
  platform?: NodeJS.Platform
  // Injected so tests are deterministic; defaults to a random uuid for a first-run installation.
  generateInstallationId?: () => string
}

export class InstallationSigningKey {
  readonly #options: InstallationSigningKeyOptions

  constructor(options: InstallationSigningKeyOptions) {
    this.#options = options
  }

  #keyPath(): string {
    return join(this.#options.getUserDataPath(), ...INSTALLATION_KEY_DIR, INSTALLATION_KEY_FILE)
  }

  #availability(): ReturnType<typeof getPieSecureStorageAvailability> {
    return getPieSecureStorageAvailability(
      this.#options.safeStorage,
      this.#options.platform ?? process.platform
    )
  }

  #identityFrom(persisted: PersistedInstallationKey): InstallationSigningIdentity {
    // The private KeyObject is reconstructed once and captured in the sign closure; it never leaves.
    const privateKeyPem = this.#options.safeStorage.decryptString(
      Buffer.from(persisted.privateKeyCiphertext, 'base64')
    )
    const privateKey = createPrivateKey(privateKeyPem)
    return {
      installationId: persisted.installationId,
      publicKeyPem: persisted.publicKeyPem,
      publicKeyId: computePublicKeyId(persisted.publicKeyPem),
      sign: (bytes: Buffer) => sign(null, bytes, privateKey)
    }
  }

  /**
   * Loads the installation signing identity, generating and persisting a new Ed25519 keypair on
   * first run. Deterministically idempotent: repeated calls return the SAME installationId and
   * public key across runs. Returns 'unavailable' when OS-backed encryption cannot protect the
   * private key at rest (never persists a plaintext key).
   */
  getOrCreate(): InstallationSigningKeyResult {
    const availability = this.#availability()
    if (!availability.available) {
      return { status: 'unavailable', reason: availability.reason }
    }
    const path = this.#keyPath()
    if (existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
        if (isPersistedInstallationKey(parsed)) {
          return { status: 'ready', identity: this.#identityFrom(parsed) }
        }
      } catch {
        // Unreadable/tampered key material is discarded below and regenerated — a fresh key means a
        // re-registration, not a wedged installation.
      }
      rmSync(path, { force: true })
    }
    return this.#generate(path)
  }

  #generate(path: string): InstallationSigningKeyResult {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const installationId = (this.#options.generateInstallationId ?? randomUUID)()
    const persisted: PersistedInstallationKey = {
      version: 1,
      format: 'electron-safe-storage-v1',
      installationId,
      publicKeyPem,
      privateKeyCiphertext: this.#options.safeStorage
        .encryptString(privateKeyPem)
        .toString('base64')
    }
    try {
      writeSecureJsonFile(path, persisted)
    } catch {
      // A failed secure write must not crash launch and must not leak key material; signing is off.
      return { status: 'unavailable', reason: 'write-failed' }
    }
    return { status: 'ready', identity: this.#identityFrom(persisted) }
  }
}
