// pie://invite/<token> deep-link parsing. This is a SIBLING of the auth-callback
// broker, not an extension of it: an invite link is an UNSOLICITED token delivery
// (no pre-registered state, no request/response handshake), whereas the auth
// broker matches a callback to a state it issued. Overloading the auth broker's
// state machine for a raw-token link would be a poor fit, so invites get their own
// bounded, validated parser here.

const PIE_INVITE_PROTOCOL = 'pie:'
const PIE_INVITE_HOST = 'invite'
const MAX_INVITE_URL_LENGTH = 2_048
// The raw token is base64url (server generates randomBytes(32).toString('base64url')
// → 43 chars); bound the accepted range defensively.
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/
const INVITE_RAW_ROUTE_PATTERN = /^pie:\/\/invite\//i

export type PieInviteLinkResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'not-invite-link' | 'malformed' | 'invalid-token' }

/**
 * Parses and validates a pie://invite/<token> deep link. Rejects anything that is
 * not a well-formed invite link with a bounded, charset-checked token — the raw
 * token is treated as opaque and never logged by callers.
 */
export function parsePieInviteUrl(rawUrl: string): PieInviteLinkResult {
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_INVITE_URL_LENGTH) {
    return { ok: false, reason: 'malformed' }
  }
  if (!INVITE_RAW_ROUTE_PATTERN.test(rawUrl)) {
    return { ok: false, reason: 'not-invite-link' }
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (parsed.protocol !== PIE_INVITE_PROTOCOL || parsed.hostname !== PIE_INVITE_HOST) {
    return { ok: false, reason: 'malformed' }
  }
  // Reject query/fragment smuggling — the token is the whole path.
  if (parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, reason: 'malformed' }
  }
  const token = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!INVITE_TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: 'invalid-token' }
  }
  return { ok: true, token }
}

export function isPieInviteUrl(value: string): boolean {
  return INVITE_RAW_ROUTE_PATTERN.test(value)
}
