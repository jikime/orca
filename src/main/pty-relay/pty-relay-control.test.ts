import { expect, test, vi } from 'vitest'
import { createInMemoryRelay } from './in-memory-relay'
import { createPtyControlFrameOpener, createPtyControlFrameSealer } from './pty-relay-e2ee'
import { createPtyRelayDriver, type PtyRelayDriver } from './pty-relay-driver'
import { createPtyRelayControlHost } from './pty-relay-control-host'
import {
  createCollabDriverStateMirror,
  type CollabDriverStateMirror,
  type TakeoverAuditEvent
} from './collab-driver-state-mirror'
import type { RelayConnect } from './relay-client-socket'

// Driver→relay→control-host stdin-path proofs. The `control` direction runs END
// TO END through the OPAQUE in-memory relay (see in-memory-relay.ts): the driver
// is a viewer-with-driver-role sending sealed `control` frames the host consumes.
// The driver-state / consent SIGNALS and the write/audit sinks are injected seams
// (their real sources are the control-plane realtime + daemon router).

const SHARED = { key: new Uint8Array(32).fill(7), e2eeSessionId: new Uint8Array(32).fill(9) }
const seal = createPtyControlFrameSealer(SHARED)
const open = createPtyControlFrameOpener(SHARED)

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function makeDriver(
  connect: RelayConnect,
  hasDriverRole: () => boolean,
  credential = 'driver-1'
): PtyRelayDriver {
  return createPtyRelayDriver({
    relayUrl: 'memory://relay',
    sessionId: 's1',
    streamId: 'stream-1',
    credential,
    seal,
    connect,
    hasDriverRole
  })
}

type HostHarness = {
  writes: Uint8Array[]
  audit: TakeoverAuditEvent[]
  connectionEnded: () => number
}

function makeControlHost(
  connect: RelayConnect,
  mirror: CollabDriverStateMirror
): { host: ReturnType<typeof createPtyRelayControlHost>; harness: HostHarness } {
  const writes: Uint8Array[] = []
  const audit: TakeoverAuditEvent[] = []
  const onConnectionShouldEnd = vi.fn()
  const host = createPtyRelayControlHost({
    relayUrl: 'memory://relay',
    sessionId: 's1',
    streamId: 'stream-1',
    credential: 'viewer-host',
    open,
    connect,
    gate: {
      isAuthorizedDriver: (sender) => mirror.isAuthorizedDriver(sender),
      isInputAllowed: () => mirror.isInputAllowed()
    },
    write: (data) => writes.push(data),
    audit: (event) => audit.push(event),
    onConnectionShouldEnd
  })
  return {
    host,
    harness: { writes, audit, connectionEnded: () => onConnectionShouldEnd.mock.calls.length }
  }
}

function makeMirror(localId: string) {
  const events: TakeoverAuditEvent[] = []
  const mirror = createCollabDriverStateMirror({
    localParticipantId: localId,
    audit: (event) => events.push(event)
  })
  return { mirror, events }
}

// Driver input flows: the authorized driver's control frames write the exact
// stdin bytes to the PTY.
test('the authorized driver writes exact stdin bytes to the host PTY', async () => {
  const relay = createInMemoryRelay()
  const { mirror } = makeMirror('local')
  const { host, harness } = makeControlHost(relay.connect, mirror)
  await host.start()

  const driver = makeDriver(relay.connect, () => true)
  await driver.start()
  // The control plane confirms consent and names THIS relay participant driver.
  mirror.onConsentConfirmed()
  // The host gate keys on the control-plane driver identity (the relay id here).
  mirror.onDriverGranted(driver.participantId()!)

  expect(driver.sendInput(enc('whoami\n'))).toBe(true)
  await waitFor(() => harness.writes.length === 1)
  expect(dec(harness.writes[0]!)).toBe('whoami\n')
})

// view ≠ control (independent host gate): a legit relay-driver whose identity is
// NOT the control-plane driver is rejected by the host's own gate — proving the
// gate is independent of the relay-provided role.
test('the host gate rejects control from a sender that is not the control-plane driver', async () => {
  const relay = createInMemoryRelay()
  const { mirror } = makeMirror('local')
  const { host, harness } = makeControlHost(relay.connect, mirror)
  await host.start()

  const driver = makeDriver(relay.connect, () => true)
  await driver.start()
  mirror.onConsentConfirmed()
  // Control plane says the driver is someone ELSE, not this sender's id.
  mirror.onDriverGranted('a-different-participant')

  expect(driver.sendInput(enc('rm -rf /\n'))).toBe(true) // relay admits (it IS a driver)
  await waitFor(() => harness.audit.length === 1)
  expect(harness.writes).toHaveLength(0)
  expect(harness.audit[0]).toMatchObject({ kind: 'control_rejected', reason: 'not_driver' })
})

// view ≠ control (relay enforcement): a non-driver (viewer credential) that tries
// to send a control frame is rejected by the relay with forbidden_control.
test('the relay rejects a control frame from a non-driver (forbidden_control)', async () => {
  const relay = createInMemoryRelay()
  const errors: string[] = []
  const viewerControl = createPtyRelayDriver({
    relayUrl: 'memory://relay',
    sessionId: 's1',
    streamId: 'stream-1',
    credential: 'viewer-sneaky', // relay assigns viewer role
    seal,
    connect: relay.connect,
    hasDriverRole: () => true, // force an attempt despite not being the driver
    onError: (message) => errors.push(message)
  })
  await viewerControl.start()

  expect(viewerControl.sendInput(enc('sudo\n'))).toBe(true)
  await waitFor(() => errors.length === 1)
  expect(errors[0]).toContain('control')
})

// Handoff: after A hands off to B, A's control is rejected and B's is accepted,
// with no window where both write.
test('handoff rejects the old driver and accepts the new one with no double-write', async () => {
  const relay = createInMemoryRelay()
  const { mirror } = makeMirror('local')
  const { host, harness } = makeControlHost(relay.connect, mirror)
  await host.start()

  const driverA = makeDriver(relay.connect, () => true, 'driver-a')
  const driverB = makeDriver(relay.connect, () => true, 'driver-b')
  await driverA.start()
  await driverB.start()
  mirror.onConsentConfirmed()
  mirror.onDriverGranted(driverA.participantId()!)

  driverA.sendInput(enc('from-a\n'))
  await waitFor(() => harness.writes.length === 1)

  // A3 handoff to B.
  mirror.onDriverHandoff(driverB.participantId()!)

  driverA.sendInput(enc('a-after-handoff\n')) // must be rejected now
  driverB.sendInput(enc('from-b\n')) // must be accepted
  await waitFor(() => harness.writes.length === 2)
  await new Promise((r) => setTimeout(r, 20))

  const written = harness.writes.map(dec)
  expect(written).toEqual(['from-a\n', 'from-b\n'])
  expect(written).not.toContain('a-after-handoff\n')
  expect(harness.audit).toContainEqual(
    expect.objectContaining({ kind: 'control_rejected', reason: 'not_driver' })
  )
})

// Consent revoke: input from the still-valid driver is blocked immediately, the
// block is audited, and the connection is asked to end.
test('consent revoke blocks the valid driver immediately and ends the connection', async () => {
  const relay = createInMemoryRelay()
  const { mirror, events } = makeMirror('local')
  const { host, harness } = makeControlHost(relay.connect, mirror)
  await host.start()

  const driver = makeDriver(relay.connect, () => true)
  await driver.start()
  mirror.onConsentConfirmed()
  mirror.onDriverGranted(driver.participantId()!)

  driver.sendInput(enc('ok\n'))
  await waitFor(() => harness.writes.length === 1)

  mirror.onConsentRevoked()
  driver.sendInput(enc('after-revoke\n'))
  await waitFor(() => harness.audit.some((e) => e.kind === 'control_rejected'))
  await new Promise((r) => setTimeout(r, 20))

  expect(harness.writes.map(dec)).toEqual(['ok\n']) // no further write
  expect(harness.connectionEnded()).toBeGreaterThan(0)
  expect(events).toContainEqual({ kind: 'input_blocked_consent_revoked' })
})

// Policy expiry: same immediate-block behavior via the second block signal.
test('policy expiry blocks input immediately from the valid driver', async () => {
  const relay = createInMemoryRelay()
  const { mirror } = makeMirror('local')
  const { host, harness } = makeControlHost(relay.connect, mirror)
  await host.start()

  const driver = makeDriver(relay.connect, () => true)
  await driver.start()
  mirror.onConsentConfirmed()
  mirror.onDriverGranted(driver.participantId()!)

  driver.sendInput(enc('before\n'))
  await waitFor(() => harness.writes.length === 1)

  mirror.onPolicyExpired()
  driver.sendInput(enc('after-expiry\n'))
  await waitFor(() => harness.audit.some((e) => e.kind === 'control_rejected'))
  await new Promise((r) => setTimeout(r, 20))
  expect(harness.writes.map(dec)).toEqual(['before\n'])
})

// Reboot / user-switch: cached driver identity + capability are NOT reused. The
// gate re-validates and rejects until fresh state is confirmed.
test('reboot/user-switch does not reuse cached capability; the gate re-validates', async () => {
  const relay = createInMemoryRelay()
  const { mirror } = makeMirror('local')
  const { host, harness } = makeControlHost(relay.connect, mirror)
  await host.start()

  const driver = makeDriver(relay.connect, () => true)
  await driver.start()
  mirror.onConsentConfirmed()
  mirror.onDriverGranted(driver.participantId()!)

  // Simulate reboot/user-switch: authority is dropped.
  mirror.onSessionInvalidated()

  // Even if the driver still tried, the host's per-frame gate rejects: identity is
  // no longer the driver AND input is not allowed until re-validation.
  const forcedDriver = makeDriver(relay.connect, () => true, 'driver-forced')
  await forcedDriver.start()
  mirror.onDriverGranted('stale-should-not-match') // not the forced driver's id
  forcedDriver.sendInput(enc('reuse-cached\n'))
  await waitFor(() => harness.audit.length >= 1)
  expect(harness.writes).toHaveLength(0)

  // Fresh, re-validated state (consent + correct driver id) restores flow.
  mirror.onConsentConfirmed()
  mirror.onDriverGranted(forcedDriver.participantId()!)
  forcedDriver.sendInput(enc('revalidated\n'))
  await waitFor(() => harness.writes.length === 1)
  expect(dec(harness.writes[0]!)).toBe('revalidated\n')
})

// A malformed (tampered) control frame writes nothing and is audited.
test('a tampered control frame writes nothing to the PTY and is audited', async () => {
  const relay = createInMemoryRelay()
  const { mirror } = makeMirror('local')
  // Tamper inbound frames so the E2EE open fails at the host.
  const tampering: RelayConnect = async (url) => {
    const sock = await relay.connect(url)
    return {
      send: (data) => sock.send(data),
      onMessage: (cb) =>
        sock.onMessage((raw) => {
          const message = JSON.parse(raw) as { type: string; dir?: string; payload?: string }
          if (message.type === 'frame' && message.dir === 'control' && message.payload) {
            const bytes = Buffer.from(message.payload, 'base64')
            bytes.writeUInt8(bytes.at(-1)! ^ 0xff, bytes.length - 1)
            cb(JSON.stringify({ ...message, payload: bytes.toString('base64') }))
            return
          }
          cb(raw)
        }),
      onClose: (cb) => sock.onClose(cb),
      close: () => sock.close()
    }
  }
  const { host, harness } = makeControlHost(tampering, mirror)
  await host.start()

  const driver = makeDriver(relay.connect, () => true)
  await driver.start()
  mirror.onConsentConfirmed()
  mirror.onDriverGranted(driver.participantId()!)

  driver.sendInput(enc('trust-me\n'))
  await waitFor(() => harness.audit.some((e) => e.kind === 'control_rejected'))
  expect(harness.writes).toHaveLength(0)
  expect(harness.audit).toContainEqual(
    expect.objectContaining({ kind: 'control_rejected', reason: 'malformed' })
  )
})

// The driver client suppresses sends the instant it loses the role — nothing
// stale leaves the client after handoff/revoke.
test('the driver client stops sending the instant it loses the role', async () => {
  const relay = createInMemoryRelay()
  const { mirror } = makeMirror('local')
  const { host, harness } = makeControlHost(relay.connect, mirror)
  await host.start()

  let hasRole = true
  const driver = makeDriver(relay.connect, () => hasRole)
  await driver.start()
  mirror.onConsentConfirmed()
  mirror.onDriverGranted(driver.participantId()!)

  expect(driver.sendInput(enc('typed\n'))).toBe(true)
  await waitFor(() => harness.writes.length === 1)

  hasRole = false // handoff/revoke reflected in the local send gate
  expect(driver.sendInput(enc('lost-role\n'))).toBe(false)
  await new Promise((r) => setTimeout(r, 20))
  expect(harness.writes.map(dec)).toEqual(['typed\n'])
})
