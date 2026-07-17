import { expect, test } from 'vitest'
import { DEFAULT_TRANSCRIPT_BOUNDS } from './agent-transcript-bounds'
import { redactTranscriptText } from './agent-transcript-redaction'
import {
  decodeTranscriptRecord,
  decodeTranscriptSnapshot,
  type RawAgentTranscriptRecord
} from './agent-transcript-record'
import {
  createShareableAgentTranscriptSource,
  createTranscriptByteOutputSource,
  type AgentTranscriptSource,
  type ShareableTranscriptOptions
} from './agent-transcript-source'
import { defaultViewerPolicy } from './agent-transcript-visibility'
import { createInMemoryRelay } from './in-memory-relay'
import { createPtyFrameOpener, createPtyFrameSealer } from './pty-relay-e2ee'
import { createPtyRelayHost } from './pty-relay-host'
import { createPtyRelayViewer, type PtyRelayViewer } from './pty-relay-viewer'
import type { PtyOutputSource } from './pty-output-source'
import type { RelayConnect } from './relay-client-socket'

// C5 end-to-end: a host shares a live agent transcript through the OPAQUE
// in-memory relay; a viewer receives ONLY the bounded, visibility-filtered,
// redacted records. Proves redaction happens PRE-SEAL (the ciphertext the relay
// ferries never contains the canary) by reusing the whole C1 seal→frame→relay
// data path — no @pie/relay fork.

const SHARED = { key: new Uint8Array(32).fill(7), e2eeSessionId: new Uint8Array(32).fill(9) }
const seal = createPtyFrameSealer(SHARED)
const open = createPtyFrameOpener(SHARED)

const CANARY = 'CANARY-e2e-4f9c-secret'

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function createFakeRawSource(snapshot: RawAgentTranscriptRecord[] = []): AgentTranscriptSource & {
  emit(record: RawAgentTranscriptRecord): void
} {
  const cbs: ((record: RawAgentTranscriptRecord) => void)[] = []
  return {
    onRecord(cb) {
      cbs.push(cb)
      return () => {}
    },
    onEnd() {
      return () => {}
    },
    snapshot: () => snapshot,
    emit(record) {
      for (const cb of cbs) {
        cb(record)
      }
    }
  }
}

// Records the raw base64 frame payloads the relay ferried, so a test can assert
// the SEALED bytes never carry the canary.
function instrumentedConnect(base: RelayConnect): { connect: RelayConnect; ferried: string[] } {
  const ferried: string[] = []
  const connect: RelayConnect = async (url) => {
    const sock = await base(url)
    return {
      send: (data) => sock.send(data),
      onMessage: (cb) =>
        sock.onMessage((raw) => {
          const message = JSON.parse(raw) as { type: string; payload?: string }
          if (message.type === 'frame' && message.payload) {
            ferried.push(message.payload)
          }
          cb(raw)
        }),
      onClose: (cb) => sock.onClose(cb),
      close: () => sock.close()
    }
  }
  return { connect, ferried }
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
    credential: 'viewer-host',
    seal,
    connect
  })
}

function makeShareOptions(
  overrides: Partial<ShareableTranscriptOptions> = {}
): ShareableTranscriptOptions {
  return {
    viewerPolicy: defaultViewerPolicy,
    redaction: (text) => redactTranscriptText(text, { deny: [CANARY] }),
    bounds: DEFAULT_TRANSCRIPT_BOUNDS,
    isSharingAuthorized: () => true,
    ...overrides
  }
}

// CAP-002: a seeded canary in a prompt AND a tool_output is redacted BEFORE the
// seal — the viewer's records and the relay-ferried ciphertext never contain it.
test('viewer receives redacted transcript; relay ferries ciphertext without the canary', async () => {
  const relay = createInMemoryRelay()
  const rawSource = createFakeRawSource()
  const shareable = createShareableAgentTranscriptSource(rawSource, makeShareOptions())
  const byteSource = createTranscriptByteOutputSource(shareable)

  const viewerConn = instrumentedConnect(relay.connect)
  const viewer = makeViewer(viewerConn.connect)
  await viewer.start()
  const host = makeHost(byteSource, instrumentedConnect(relay.connect).connect)
  await host.start()

  rawSource.emit({ type: 'user_prompt', text: `deploy with ${CANARY}` })
  rawSource.emit({ type: 'system', text: `internal ${CANARY}` }) // hidden from viewer
  rawSource.emit({ type: 'tool_output', text: `stdout: token=${CANARY}` })

  await waitFor(() => viewer.received().length === 2) // system was hidden

  // The C1 viewer strips the pty-stream-frame kind, so each received chunk is the
  // record JSON directly.
  const records = viewer.received().map((bytes) => decodeTranscriptRecord(bytes))
  expect(records.map((r) => r?.type)).toEqual(['user_prompt', 'tool_output'])
  for (const record of records) {
    expect(record?.text).not.toContain(CANARY)
    expect(record?.text).toContain('‹redacted:deny›')
  }

  // The sealed bytes the relay ferried never contain the canary (redact-pre-seal).
  for (const payload of viewerConn.ferried) {
    const ferried = Buffer.from(payload, 'base64')
    expect(ferried.includes(Buffer.from(CANARY, 'utf8'))).toBe(false)
  }
})

// CAP-003: an oversized poison record is quarantined end-to-end (never sealed,
// never received) while healthy records still reach the viewer.
test('an oversized record is quarantined and never reaches the viewer', async () => {
  const relay = createInMemoryRelay()
  const rawSource = createFakeRawSource()
  const quarantined: string[] = []
  const shareable = createShareableAgentTranscriptSource(
    rawSource,
    makeShareOptions({
      bounds: { maxRecordBytes: 256, maxLineBytes: 128, maxJsonDepth: 8 },
      onAudit: (event) => {
        if (event.kind === 'quarantined') {
          quarantined.push(event.reason)
        }
      }
    })
  )
  const byteSource = createTranscriptByteOutputSource(shareable)

  const viewer = makeViewer(instrumentedConnect(relay.connect).connect)
  await viewer.start()
  const host = makeHost(byteSource, instrumentedConnect(relay.connect).connect)
  await host.start()

  rawSource.emit({ type: 'assistant_msg', text: 'ok-1' })
  rawSource.emit({ type: 'assistant_msg', text: 'a'.repeat(5000) }) // poison
  rawSource.emit({ type: 'assistant_msg', text: 'ok-2' })

  await waitFor(() => viewer.received().length === 2)
  const texts = viewer.received().map((bytes) => decodeTranscriptRecord(bytes)?.text)
  expect(texts).toEqual(['ok-1', 'ok-2'])
  expect(quarantined).toEqual(['record_too_large'])
})

// CAP-006: after authorization flips false, queued/subsequent records are not
// sealed and never reach the viewer.
test('records after authorization is revoked never reach the viewer', async () => {
  const relay = createInMemoryRelay()
  const rawSource = createFakeRawSource()
  let authorized = true
  const shareable = createShareableAgentTranscriptSource(
    rawSource,
    makeShareOptions({ isSharingAuthorized: () => authorized })
  )
  const byteSource = createTranscriptByteOutputSource(shareable)

  const viewer = makeViewer(instrumentedConnect(relay.connect).connect)
  await viewer.start()
  const host = makeHost(byteSource, instrumentedConnect(relay.connect).connect)
  await host.start()

  rawSource.emit({ type: 'assistant_msg', text: 'seen' })
  await waitFor(() => viewer.received().length === 1)
  authorized = false
  rawSource.emit({ type: 'assistant_msg', text: 'revoked' })

  // Give any (incorrect) emission a chance to arrive, then assert it did not.
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(viewer.received()).toHaveLength(1)
  const text = decodeTranscriptRecord(viewer.received()[0]!)?.text
  expect(text).toBe('seen')
})

// Late-joiner catch-up: the snapshot seed is the filtered/redacted projection.
test('a late viewer receives the redacted/filtered snapshot first', async () => {
  const relay = createInMemoryRelay()
  const rawSource = createFakeRawSource([
    { type: 'user_prompt', text: `prompt ${CANARY}` },
    { type: 'system', text: 'internal only' }
  ])
  const shareable = createShareableAgentTranscriptSource(rawSource, makeShareOptions())
  const byteSource = createTranscriptByteOutputSource(shareable)

  const viewerConn = instrumentedConnect(relay.connect)
  const viewer = makeViewer(viewerConn.connect)
  await viewer.start()
  const host = makeHost(byteSource, instrumentedConnect(relay.connect).connect)
  await host.start() // emits the snapshot seed on join

  await waitFor(() => viewer.received().length === 1)
  // The catch-up seed rides the snapshot frame; its payload is the JSON array of
  // filtered/redacted records (system was filtered out).
  const records = decodeTranscriptSnapshot(viewer.received()[0]!)
  expect(records?.map((r) => r.type)).toEqual(['user_prompt'])
  expect(records![0]!.text).not.toContain(CANARY)

  for (const payload of viewerConn.ferried) {
    const ferried = Buffer.from(payload, 'base64')
    expect(ferried.includes(Buffer.from(CANARY, 'utf8'))).toBe(false)
  }
})
