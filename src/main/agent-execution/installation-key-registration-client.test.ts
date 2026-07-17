import { describe, expect, it, vi } from 'vitest'
import {
  InstallationKeyRegistrationError,
  registerInstallationKey
} from './installation-key-registration-client'

const PARAMS = {
  organizationId: '20000000-0000-4000-8000-000000000001',
  installationId: 'inst-1',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n'
}

describe('registerInstallationKey', () => {
  it('POSTs the public key with the org-scoped path, bearer auth, and idempotency key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 201 }))
    await registerInstallationKey(
      {
        getApiBaseUrl: () => 'https://cp.example.com/v1',
        getAccessToken: () => 'tok-123',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        newId: () => 'idem-1'
      },
      PARAMS
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      'https://cp.example.com/v1/organizations/20000000-0000-4000-8000-000000000001/installation-keys'
    )
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-123')
    expect(headers['idempotency-key']).toBe('idem-1')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      installationId: 'inst-1',
      publicKey: PARAMS.publicKeyPem,
      algorithm: 'ed25519'
    })
  })

  it('never puts the token in the request body', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    await registerInstallationKey(
      {
        getApiBaseUrl: () => 'https://cp.example.com/v1',
        getAccessToken: () => 'super-secret-token',
        fetchImpl: fetchImpl as unknown as typeof fetch
      },
      PARAMS
    )
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body as string).not.toContain('super-secret-token')
  })

  it('throws (unauthenticated) rather than build a request without a token', async () => {
    const fetchImpl = vi.fn()
    await expect(
      registerInstallationKey(
        {
          getApiBaseUrl: () => 'https://cp.example.com/v1',
          getAccessToken: () => null,
          fetchImpl: fetchImpl as unknown as typeof fetch
        },
        PARAMS
      )
    ).rejects.toBeInstanceOf(InstallationKeyRegistrationError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws with the HTTP status on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(
      registerInstallationKey(
        {
          getApiBaseUrl: () => 'https://cp.example.com/v1',
          getAccessToken: () => 'tok',
          fetchImpl: fetchImpl as unknown as typeof fetch
        },
        PARAMS
      )
    ).rejects.toMatchObject({ status: 500 })
  })
})
