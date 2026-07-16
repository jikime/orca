import { describe, expect, it, vi } from 'vitest'
import { InMemoryDesktopSessionBroker } from './desktop-session-broker'

const userId = '10000000-0000-4000-8000-000000000001'
const organizationId = '10000000-0000-4000-8000-000000000002'
const sessionId = '10000000-0000-4000-8000-000000000003'

function authenticatedSession() {
  return {
    status: 'signed_in' as const,
    instanceId: 'local-desktop',
    userId,
    displayName: 'Pie User',
    organizationId,
    permissions: ['project.read'],
    expiresAt: '2026-07-16T01:00:00.000Z'
  }
}

describe('InMemoryDesktopSessionBroker', () => {
  it('starts signed out and returns defensive state copies', () => {
    const broker = new InMemoryDesktopSessionBroker()
    const first = broker.getState()
    expect(first).toEqual({ status: 'signed_out', instanceId: 'local-desktop' })
    expect(broker.getContext()).toEqual({
      instanceId: 'local-desktop',
      sessionId: null,
      organizationId: null
    })

    ;(first as Record<string, unknown>).unexpected = true
    expect(broker.getState()).not.toHaveProperty('unexpected')
  })

  it('publishes monotonic, token-free session changes', () => {
    const broker = new InMemoryDesktopSessionBroker()
    const listener = vi.fn()
    const unsubscribe = broker.subscribe(listener)

    broker.replaceSession({ session: authenticatedSession(), sessionId })
    expect(broker.getContext()).toEqual({
      instanceId: 'local-desktop',
      sessionId,
      organizationId
    })
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.changed',
        protocolVersion: '1.0',
        sequence: 1,
        session: authenticatedSession()
      })
    )

    unsubscribe()
    broker.replaceSession({
      session: { status: 'signed_out', instanceId: 'local-desktop' },
      sessionId: null
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rejects missing session IDs, mismatched instances, and token fields', () => {
    const broker = new InMemoryDesktopSessionBroker()
    expect(() =>
      broker.replaceSession({ session: authenticatedSession(), sessionId: null })
    ).toThrow('require a session ID')
    expect(() =>
      broker.replaceSession({
        session: { ...authenticatedSession(), instanceId: 'other-instance' },
        sessionId
      })
    ).toThrow('does not match')
    expect(() =>
      broker.replaceSession({
        session: { ...authenticatedSession(), accessToken: 'secret' },
        sessionId
      })
    ).toThrow()
  })
})
