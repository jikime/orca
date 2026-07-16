export type PieSafeStorageLike = {
  isEncryptionAvailable: () => boolean
  getSelectedStorageBackend?: () => string
}

export type PieSecureStorageAvailability =
  | { available: true; backend: string }
  | {
      available: false
      reason: 'encryption-unavailable' | 'linux-basic-text-backend'
    }

/**
 * Decides whether OS-backed encryption is trustworthy enough to persist Pie
 * refresh tokens. When unavailable, only persistent login is disabled — the
 * signed-in session keeps working from Main memory until the app exits.
 */
export function getPieSecureStorageAvailability(
  safeStorage: PieSafeStorageLike,
  platform: NodeJS.Platform = process.platform
): PieSecureStorageAvailability {
  if (!safeStorage.isEncryptionAvailable()) {
    return { available: false, reason: 'encryption-unavailable' }
  }
  if (platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
    // Why: basic_text derives the key from a hardcoded string, so "encrypted"
    // files are plaintext-equivalent. Refuse rather than fake protection.
    if (backend === 'basic_text' || backend === 'unknown') {
      return { available: false, reason: 'linux-basic-text-backend' }
    }
    return { available: true, backend }
  }
  // Why: macOS Keychain and Windows DPAPI are the only backends Electron uses
  // on those platforms, so isEncryptionAvailable() is sufficient there.
  return { available: true, backend: platform === 'darwin' ? 'keychain' : 'dpapi' }
}
