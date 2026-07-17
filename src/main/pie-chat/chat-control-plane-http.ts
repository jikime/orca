// Shared HTTP helpers for the Control Plane collaboration (chat) clients. The
// access token is sent as a bearer and never appears in a log line. apiBaseUrl
// already includes /v1 (mirrors platform-session-client).

export class PieChatError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'PieChatError'
    this.status = status
  }
}

export function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
}

export function jsonHeaders(accessToken: string): Record<string, string> {
  return { ...authHeaders(accessToken), 'content-type': 'application/json' }
}

export function orgBase(apiBaseUrl: string, organizationId: string): string {
  return `${apiBaseUrl}/organizations/${organizationId}`
}

export function channelsBase(apiBaseUrl: string, organizationId: string): string {
  return `${orgBase(apiBaseUrl, organizationId)}/channels`
}
