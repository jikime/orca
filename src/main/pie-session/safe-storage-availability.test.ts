import { describe, expect, it } from 'vitest'
import { getPieSecureStorageAvailability } from './safe-storage-availability'

function fakeSafeStorage(options: { encryptionAvailable?: boolean; backend?: string } = {}): {
  isEncryptionAvailable: () => boolean
  getSelectedStorageBackend?: () => string
} {
  return {
    isEncryptionAvailable: () => options.encryptionAvailable ?? true,
    ...(options.backend === undefined
      ? {}
      : { getSelectedStorageBackend: () => options.backend as string })
  }
}

describe('getPieSecureStorageAvailability', () => {
  it('accepts macOS Keychain when encryption is available', () => {
    expect(getPieSecureStorageAvailability(fakeSafeStorage(), 'darwin')).toEqual({
      available: true,
      backend: 'keychain'
    })
  })

  it('accepts Windows DPAPI when encryption is available', () => {
    expect(getPieSecureStorageAvailability(fakeSafeStorage(), 'win32')).toEqual({
      available: true,
      backend: 'dpapi'
    })
  })

  it('accepts Linux Secret Service backends', () => {
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
      expect(getPieSecureStorageAvailability(fakeSafeStorage({ backend }), 'linux')).toEqual({
        available: true,
        backend
      })
    }
  })

  it('rejects the Linux basic_text backend', () => {
    expect(
      getPieSecureStorageAvailability(fakeSafeStorage({ backend: 'basic_text' }), 'linux')
    ).toEqual({ available: false, reason: 'linux-basic-text-backend' })
  })

  it('rejects Linux when the backend cannot be identified', () => {
    expect(
      getPieSecureStorageAvailability(fakeSafeStorage({ backend: 'unknown' }), 'linux')
    ).toEqual({ available: false, reason: 'linux-basic-text-backend' })
    expect(getPieSecureStorageAvailability(fakeSafeStorage(), 'linux')).toEqual({
      available: false,
      reason: 'linux-basic-text-backend'
    })
  })

  it('reports encryption-unavailable on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(
        getPieSecureStorageAvailability(fakeSafeStorage({ encryptionAvailable: false }), platform)
      ).toEqual({ available: false, reason: 'encryption-unavailable' })
    }
  })
})
