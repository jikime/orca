import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame,
  type MobileE2EEDirection
} from '../../shared/mobile-e2ee-v2-framing'

// E2EE seal/open for the PTY relay bridge, reusing the canonical mobile E2EE v2
// framing (doc 32 baseline) so the relay only ever ferries ciphertext.
//
// C1 KEY ASSUMPTION: the 32-byte `key` and 32-byte `e2eeSessionId` are a shared
// secret handed to BOTH the host and the viewer out of band (config). Real key
// agreement — deriving these from the pairing/consent handshake — is a later
// Phase C key-exchange slice. C1 proves only the opaque relay data path plus the
// endpoint-to-endpoint seal/open, not the key negotiation.
//
// The relay `seq` doubles as the E2EE counter: it is strictly monotonic per
// stream, so every frame gets a unique nonce with no extra RNG draw.

export type PtyRelayE2EEKey = {
  key: Uint8Array
  e2eeSessionId: Uint8Array
}

export type PtyFrameSealer = (payload: Uint8Array, counter: bigint) => Uint8Array
export type PtyFrameOpener = (sealed: Uint8Array, counter: bigint) => Uint8Array | null

// Host → viewer is the desktop-originated direction; PTY bytes are opaque binary.
const HOST_DIRECTION: MobileE2EEDirection = 'desktop-to-mobile'

export function createPtyFrameSealer(shared: PtyRelayE2EEKey): PtyFrameSealer {
  return (payload, counter) =>
    sealMobileE2EEV2Frame({
      payload,
      key: shared.key,
      sessionId: shared.e2eeSessionId,
      direction: HOST_DIRECTION,
      payloadKind: 'binary',
      counter
    })
}

export function createPtyFrameOpener(shared: PtyRelayE2EEKey): PtyFrameOpener {
  return (sealed, counter) =>
    openMobileE2EEV2Frame({
      frame: sealed,
      key: shared.key,
      sessionId: shared.e2eeSessionId,
      direction: HOST_DIRECTION,
      payloadKind: 'binary',
      expectedCounter: counter
    })
}
