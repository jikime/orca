import type { PieAuthCallbackBroker } from '../pie-deep-link/pie-auth-callback'

// One interface over the two RFC 8252 redirect modes: the loopback HTTP server
// (preferred) and the pie:// private-URI-scheme deep link (fallback, via the R1
// broker). The service picks a mode from the discovery document's redirectModes
// and drives both identically.

export type CallbackOutcome =
  | { outcome: 'success'; code: string; state: string }
  | { outcome: 'error'; errorCode: string; state: string }

export type CallbackChannel = {
  redirectUri: string
  // Resolves on a matched callback; rejects on timeout or an aborted channel.
  // State is guaranteed to match — both modes validate it before resolving.
  waitForCallback: () => Promise<CallbackOutcome>
  close: () => void
}

export class CallbackChannelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CallbackChannelError'
  }
}

export const PIE_AUTH_DEEP_LINK_REDIRECT_URI = 'pie://auth/callback'

export type DeepLinkCallbackChannelInput = {
  broker: PieAuthCallbackBroker
  state: string
  expiresAtMs: number
  timeoutMs: number
}

/**
 * The pie:// fallback channel. Registers the expected state with the R1 broker,
 * which validates state and replay on dispatch, so this channel only ever sees a
 * state-matched callback.
 */
export function createDeepLinkCallbackChannel(
  input: DeepLinkCallbackChannelInput
): CallbackChannel {
  let settle: ((outcome: CallbackOutcome) => void) | null = null
  let fail: ((error: Error) => void) | null = null
  const promise = new Promise<CallbackOutcome>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const cancel = input.broker.registerExpectedCallback({
    state: input.state,
    expiresAtMs: input.expiresAtMs,
    onCallback: (callback) => {
      if (callback.outcome === 'success') {
        settle?.({ outcome: 'success', code: callback.authorizationCode, state: callback.state })
      } else {
        settle?.({ outcome: 'error', errorCode: callback.errorCode, state: callback.state })
      }
    }
  })
  const timer = setTimeout(() => {
    fail?.(new CallbackChannelError('deep-link callback timed out'))
  }, input.timeoutMs)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
  const close = (): void => {
    clearTimeout(timer)
    cancel()
  }
  return {
    redirectUri: PIE_AUTH_DEEP_LINK_REDIRECT_URI,
    waitForCallback: () =>
      promise.finally(() => {
        clearTimeout(timer)
      }),
    close
  }
}
