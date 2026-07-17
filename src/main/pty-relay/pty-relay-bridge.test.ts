import { expect, test } from 'vitest'
import { createInMemoryRelay } from './in-memory-relay'
import { createPtyFrameOpener, createPtyFrameSealer } from './pty-relay-e2ee'
import { createPtyRelayHost } from './pty-relay-host'
import { createPtyRelayViewer, type PtyRelayViewer } from './pty-relay-viewer'
import type { RelayConnect } from './relay-client-socket'
import type { PtyOutputSource } from './pty-output-source'

// Host→relay→viewer data-path proofs. The relay here is an OPAQUE in-memory
// double (see in-memory-relay.ts); the same proofs run against the REAL relay in
// platform/apps/relay/src/pty-relay-bridge-e2e.test.ts.

// C1 shared endpoint key + E2EE session id (config-provided; real key agreement
// is a later slice — see pty-relay-e2ee.ts).
const SHARED = { key: new Uint8Array(32).fill(7), e2eeSessionId: new Uint8Array(32).fill(9) }
const seal = createPtyFrameSealer(SHARED)
const open = createPtyFrameOpener(SHARED)

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// Fake PtyOutputSource the test drives directly — no real PTY.
function createFakeSource(snapshot: Uint8Array | null): PtyOutputSource & {
  emit(chunk: Uint8Array): void
  fireExit(): void
} {
  const dataCbs: ((chunk: Uint8Array) => void)[] = []
  const exitCbs: (() => void)[] = []
  return {
    onData(cb) {
      dataCbs.push(cb)
      return () => {}
    },
    onExit(cb) {
      exitCbs.push(cb)
      return () => {}
    },
    snapshot: () => snapshot,
    emit(chunk) {
      for (const cb of dataCbs) {
        cb(chunk)
      }
    },
    fireExit() {
      for (const cb of exitCbs) {
        cb()
      }
    }
  }
}

// Wraps a base connector to record raw sent/received messages and, optionally,
// tamper inbound frames in transit (relay-side mutation simulation).
function instrumentedConnect(
  base: RelayConnect,
  opts?: { tamper?: (raw: string) => string }
): { connect: RelayConnect; sent: string[]; received: string[] } {
  const sent: string[] = []
  const received: string[] = []
  const connect: RelayConnect = async (url) => {
    const sock = await base(url)
    return {
      send: (data) => {
        sent.push(data)
        sock.send(data)
      },
      onMessage: (cb) =>
        sock.onMessage((raw) => {
          const delivered = opts?.tamper ? opts.tamper(raw) : raw
          received.push(delivered)
          cb(delivered)
        }),
      onClose: (cb) => sock.onClose(cb),
      close: () => sock.close()
    }
  }
  return { connect, sent, received }
}

function makeViewer(connect: RelayConnect): PtyRelayViewer {
  return createPtyRelayViewer({
    relayUrl: 'memory://relay',
    sessionId: 's1',
    streamId: 'stream-1',
    credential: 'viewer-1',
    open,
    connect
  })
}

function makeHost(source: PtyOutputSource, connect: RelayConnect) {
  return createPtyRelayHost({
    outputSource: source,
    relayUrl: 'memory://relay',
    sessionId: 's1',
    streamId: 'stream-1',
    // view-only C1: the host also joins as a viewer; any role may send `output`.
    credential: 'viewer-host',
    seal,
    connect
  })
}

// (a) order preserved + (b) relay ferried ciphertext only.
test('viewer receives host PTY output in order; relay ferries ciphertext only', async () => {
  const relay = createInMemoryRelay()
  const source = createFakeSource(null)
  const viewerConn = instrumentedConnect(relay.connect)
  const viewer = makeViewer(viewerConn.connect)
  await viewer.start()
  const host = makeHost(source, instrumentedConnect(relay.connect).connect)
  await host.start()

  const chunks = [enc('line-1\n'), enc('super-secret-line-2\n'), enc('line-3\n')]
  for (const chunk of chunks) {
    source.emit(chunk)
  }

  await waitFor(() => viewer.received().length === 3)
  // (a) exact bytes, in order.
  expect(dec(concat(viewer.received()))).toBe('line-1\nsuper-secret-line-2\nline-3\n')

  // (b) the bytes the relay ferried are the SEALED ciphertext, never plaintext.
  const ferriedFrames = viewerConn.received
    .map((raw) => JSON.parse(raw) as { type: string; payload?: string })
    .filter((m) => m.type === 'frame')
  expect(ferriedFrames).toHaveLength(3)
  for (const frame of ferriedFrames) {
    const ferried = Buffer.from(frame.payload!, 'base64')
    expect(ferried.includes(Buffer.from(enc('super-secret-line-2\n')))).toBe(false)
    expect(ferried.includes(Buffer.from(enc('line-1\n')))).toBe(false)
  }
})

// (c) late-join catch-up: a viewer that missed the original output still gets the
// snapshot first, so it is not blank.
test('late viewer receives the snapshot first (catch-up)', async () => {
  const relay = createInMemoryRelay()
  const source = createFakeSource(enc('PRIOR-SCREEN-STATE'))
  const viewer = makeViewer(instrumentedConnect(relay.connect).connect)
  await viewer.start()
  const host = makeHost(source, instrumentedConnect(relay.connect).connect)
  await host.start() // sends snapshot on join, before any live output

  source.emit(enc('live-after-join'))

  await waitFor(() => viewer.received().length === 2)
  expect(dec(viewer.received()[0]!)).toBe('PRIOR-SCREEN-STATE')
  expect(dec(viewer.received()[1]!)).toBe('live-after-join')
})

// (d) tamper → open returns null → surfaced as error, no garbage emitted.
test('a tampered ferried frame is surfaced as an error and never emitted', async () => {
  const relay = createInMemoryRelay()
  const source = createFakeSource(null)
  const errors: string[] = []
  const tamperingConn = instrumentedConnect(relay.connect, {
    tamper: (raw) => {
      const message = JSON.parse(raw) as { type: string; payload?: string }
      if (message.type !== 'frame' || !message.payload) {
        return raw
      }
      const bytes = Buffer.from(message.payload, 'base64')
      bytes.writeUInt8(bytes.at(-1)! ^ 0xff, bytes.length - 1) // flip last ciphertext byte
      return JSON.stringify({ ...message, payload: bytes.toString('base64') })
    }
  })
  const viewer = makeViewer(tamperingConn.connect)
  viewer.onError((message) => errors.push(message))
  await viewer.start()
  const host = makeHost(source, instrumentedConnect(relay.connect).connect)
  await host.start()

  source.emit(enc('trust-me'))

  await waitFor(() => errors.length === 1)
  expect(viewer.received()).toHaveLength(0) // no garbage reached the terminal
})

// (e) PTY exit propagates to the viewer.
test('PTY exit propagates to the viewer as an exit event', async () => {
  const relay = createInMemoryRelay()
  const source = createFakeSource(null)
  const viewer = makeViewer(instrumentedConnect(relay.connect).connect)
  let exited = false
  viewer.onExit(() => {
    exited = true
  })
  await viewer.start()
  const host = makeHost(source, instrumentedConnect(relay.connect).connect)
  await host.start()

  source.emit(enc('bye\n'))
  await waitFor(() => viewer.received().length === 1)
  source.fireExit()

  await waitFor(() => exited)
  expect(exited).toBe(true)
})

// (f) view-only: the viewer only ever sends join/leave — never a frame.
test('the viewer never sends a frame (view-only)', async () => {
  const relay = createInMemoryRelay()
  const source = createFakeSource(enc('snap'))
  const viewerConn = instrumentedConnect(relay.connect)
  const viewer = makeViewer(viewerConn.connect)
  await viewer.start()
  const host = makeHost(source, instrumentedConnect(relay.connect).connect)
  await host.start()

  source.emit(enc('some-output'))
  await waitFor(() => viewer.received().length === 2)
  await viewer.stop()

  const sentTypes = viewerConn.sent.map((raw) => (JSON.parse(raw) as { type: string }).type)
  expect(sentTypes).toEqual(['join', 'leave'])
  expect(sentTypes).not.toContain('frame')
})
