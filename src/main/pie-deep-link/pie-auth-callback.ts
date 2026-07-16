const PIE_AUTH_CALLBACK_PROTOCOL = 'pie:'
const PIE_AUTH_CALLBACK_HOST = 'auth'
const PIE_AUTH_CALLBACK_PATH = '/callback'
const MAX_CALLBACK_URL_LENGTH = 8_192
const MAX_AUTHORIZATION_CODE_LENGTH = 4_096
const MAX_STATE_LENGTH = 256
const MAX_ERROR_DESCRIPTION_LENGTH = 512
const MAX_PENDING_CALLBACKS = 8
const MAX_CALLBACK_LIFETIME_MS = 10 * 60 * 1_000
const REPLAY_RETENTION_MS = 5 * 60 * 1_000

const AUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/
const AUTHORIZATION_CODE_PATTERN = /^[\x21-\x7e]+$/
const AUTH_ERROR_PATTERN = /^[a-z_]{1,64}$/
const AUTH_CALLBACK_RAW_ROUTE_PATTERN = /^pie:\/\/auth\/callback\?/i
const MALFORMED_PERCENT_ENCODING_PATTERN = /%(?![0-9A-Fa-f]{2})/

const SUCCESS_QUERY_KEYS = new Set(['code', 'state'])
const ERROR_QUERY_KEYS = new Set(['error', 'error_description', 'state'])

export type PieAuthCallback =
  | {
      authorizationCode: string
      outcome: 'success'
      state: string
    }
  | {
      errorCode: string
      outcome: 'error'
      state: string
    }

export type PieAuthCallbackParseFailure =
  | 'invalid-url'
  | 'invalid-route'
  | 'invalid-query'
  | 'invalid-state'

export type PieAuthCallbackParseResult =
  | { callback: PieAuthCallback; ok: true }
  | { ok: false; reason: PieAuthCallbackParseFailure }

export type PieAuthCallbackDispatchResult =
  | { status: 'delivered' }
  | {
      reason:
        | 'expired-state'
        | 'handler-failed'
        | 'invalid-link'
        | 'replayed-state'
        | 'unexpected-state'
      status: 'rejected'
    }

type PendingAuthCallback = {
  expiresAtMs: number
  onCallback: (callback: PieAuthCallback) => void
}

export type RegisterExpectedPieAuthCallbackInput = PendingAuthCallback & {
  state: string
}

function hasOnlyKeys(searchParams: URLSearchParams, allowedKeys: ReadonlySet<string>): boolean {
  return [...searchParams.keys()].every((key) => allowedKeys.has(key))
}

function getSingleValue(searchParams: URLSearchParams, key: string): string | null {
  const values = searchParams.getAll(key)
  return values.length === 1 ? values[0] : null
}

function isValidState(state: string): boolean {
  return state.length <= MAX_STATE_LENGTH && AUTH_STATE_PATTERN.test(state)
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
}

function parseSuccessCallback(searchParams: URLSearchParams): PieAuthCallbackParseResult {
  if (!hasOnlyKeys(searchParams, SUCCESS_QUERY_KEYS)) {
    return { ok: false, reason: 'invalid-query' }
  }
  const authorizationCode = getSingleValue(searchParams, 'code')
  const state = getSingleValue(searchParams, 'state')
  if (
    !authorizationCode ||
    authorizationCode.length > MAX_AUTHORIZATION_CODE_LENGTH ||
    !AUTHORIZATION_CODE_PATTERN.test(authorizationCode)
  ) {
    return { ok: false, reason: 'invalid-query' }
  }
  if (!state || !isValidState(state)) {
    return { ok: false, reason: 'invalid-state' }
  }
  return { callback: { authorizationCode, outcome: 'success', state }, ok: true }
}

function parseErrorCallback(searchParams: URLSearchParams): PieAuthCallbackParseResult {
  if (!hasOnlyKeys(searchParams, ERROR_QUERY_KEYS)) {
    return { ok: false, reason: 'invalid-query' }
  }
  const errorCode = getSingleValue(searchParams, 'error')
  const state = getSingleValue(searchParams, 'state')
  const descriptions = searchParams.getAll('error_description')
  if (!errorCode || !AUTH_ERROR_PATTERN.test(errorCode) || descriptions.length > 1) {
    return { ok: false, reason: 'invalid-query' }
  }
  const [description] = descriptions
  if (
    description !== undefined &&
    (description.length > MAX_ERROR_DESCRIPTION_LENGTH || containsControlCharacter(description))
  ) {
    return { ok: false, reason: 'invalid-query' }
  }
  if (!state || !isValidState(state)) {
    return { ok: false, reason: 'invalid-state' }
  }
  // Why: identity-provider descriptions are untrusted display text; only the bounded code crosses Main.
  return { callback: { errorCode, outcome: 'error', state }, ok: true }
}

export function parsePieAuthCallbackUrl(rawUrl: string): PieAuthCallbackParseResult {
  if (
    rawUrl.length === 0 ||
    rawUrl.length > MAX_CALLBACK_URL_LENGTH ||
    rawUrl.trim() !== rawUrl ||
    MALFORMED_PERCENT_ENCODING_PATTERN.test(rawUrl)
  ) {
    return { ok: false, reason: 'invalid-url' }
  }
  if (!AUTH_CALLBACK_RAW_ROUTE_PATTERN.test(rawUrl)) {
    return { ok: false, reason: 'invalid-route' }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }

  if (
    parsedUrl.protocol !== PIE_AUTH_CALLBACK_PROTOCOL ||
    parsedUrl.hostname !== PIE_AUTH_CALLBACK_HOST ||
    parsedUrl.pathname !== PIE_AUTH_CALLBACK_PATH ||
    parsedUrl.username !== '' ||
    parsedUrl.password !== '' ||
    parsedUrl.port !== '' ||
    parsedUrl.hash !== ''
  ) {
    return { ok: false, reason: 'invalid-route' }
  }

  const hasCode = parsedUrl.searchParams.has('code')
  const hasError = parsedUrl.searchParams.has('error')
  if (hasCode === hasError) {
    return { ok: false, reason: 'invalid-query' }
  }
  return hasCode
    ? parseSuccessCallback(parsedUrl.searchParams)
    : parseErrorCallback(parsedUrl.searchParams)
}

export class PieAuthCallbackBroker {
  private readonly consumedStates = new Map<string, number>()
  private readonly pendingCallbacks = new Map<string, PendingAuthCallback>()

  constructor(private readonly now: () => number = Date.now) {}

  registerExpectedCallback(input: RegisterExpectedPieAuthCallbackInput): () => void {
    const nowMs = this.now()
    this.removeExpiredConsumedStates(nowMs)
    if (!isValidState(input.state)) {
      throw new Error('Pie auth callback state must be a base64url value between 32 and 256 bytes')
    }
    if (input.expiresAtMs <= nowMs || input.expiresAtMs - nowMs > MAX_CALLBACK_LIFETIME_MS) {
      throw new Error('Pie auth callback expiry must be within the next 10 minutes')
    }
    if (this.pendingCallbacks.has(input.state) || this.consumedStates.has(input.state)) {
      throw new Error('Pie auth callback state is already registered or consumed')
    }
    if (this.pendingCallbacks.size >= MAX_PENDING_CALLBACKS) {
      throw new Error('Too many pending Pie auth callbacks')
    }

    const pending: PendingAuthCallback = {
      expiresAtMs: input.expiresAtMs,
      onCallback: input.onCallback
    }
    this.pendingCallbacks.set(input.state, pending)
    return () => {
      if (this.pendingCallbacks.get(input.state) === pending) {
        this.pendingCallbacks.delete(input.state)
        this.rememberConsumedState(input.state, this.now())
      }
    }
  }

  dispatch(rawUrl: string): PieAuthCallbackDispatchResult {
    const parsed = parsePieAuthCallbackUrl(rawUrl)
    if (!parsed.ok) {
      return { reason: 'invalid-link', status: 'rejected' }
    }

    const nowMs = this.now()
    this.removeExpiredConsumedStates(nowMs)
    if (this.consumedStates.has(parsed.callback.state)) {
      return { reason: 'replayed-state', status: 'rejected' }
    }

    const pending = this.pendingCallbacks.get(parsed.callback.state)
    if (!pending) {
      return { reason: 'unexpected-state', status: 'rejected' }
    }
    this.pendingCallbacks.delete(parsed.callback.state)
    this.rememberConsumedState(parsed.callback.state, nowMs)
    if (pending.expiresAtMs <= nowMs) {
      return { reason: 'expired-state', status: 'rejected' }
    }

    try {
      pending.onCallback(parsed.callback)
      return { status: 'delivered' }
    } catch {
      // Why: state consumption happens before the handler so a failed exchange cannot replay a callback.
      return { reason: 'handler-failed', status: 'rejected' }
    }
  }

  private rememberConsumedState(state: string, nowMs: number): void {
    this.consumedStates.set(state, nowMs + REPLAY_RETENTION_MS)
    while (this.consumedStates.size > MAX_PENDING_CALLBACKS * 4) {
      const oldestState = this.consumedStates.keys().next().value
      if (oldestState === undefined) {
        break
      }
      this.consumedStates.delete(oldestState)
    }
  }

  private removeExpiredConsumedStates(nowMs: number): void {
    for (const [state, expiresAtMs] of this.consumedStates) {
      if (expiresAtMs <= nowMs) {
        this.consumedStates.delete(state)
      }
    }
  }
}

export const pieAuthCallbackBroker = new PieAuthCallbackBroker()
