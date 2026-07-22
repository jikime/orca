import type {
  PieControlPlaneMethod,
  PieControlPlaneResponse
} from '../../../../shared/pie-control-plane-ipc'

// A non-2xx control-plane response, carrying the RFC-9457 problem body so a screen
// can show the server's title/detail (e.g. a 422 CHANGE_NOT_APPROVED reason).
export class PieApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly problem: unknown
  constructor(response: PieControlPlaneResponse) {
    const problem = response.data as { title?: string; code?: string; detail?: string } | null
    super(problem?.detail || problem?.title || `request failed with ${response.status}`)
    this.name = 'PieApiError'
    this.status = response.status
    this.code = problem?.code
    this.problem = response.data
  }
}

// The control-plane OCC etag: `"<resource-prefix>-<version>"` (the prefix is
// per-resource, e.g. 'change-request', 'invoice'). Screens pass their prefix.
export function resourceEtag(prefix: string, version: number): string {
  return `"${prefix}-${version}"`
}

function randomId(): string {
  return globalThis.crypto.randomUUID()
}

async function call(
  method: PieControlPlaneMethod,
  path: string,
  opts: { body?: unknown; ifMatch?: string; idempotencyKey?: string } = {}
): Promise<unknown> {
  // The bridge lands in the preload, which only rebuilds on a full app restart;
  // under dev HMR the renderer can run ahead of it. Fail with a clear message
  // instead of a bare "undefined is not a function".
  const control = window.api?.pie?.control
  if (!control) {
    throw new Error('Pie API bridge not loaded — fully restart the app to use this surface.')
  }
  const response = await control.call({ method, path, ...opts })
  if (!response.ok) {
    throw new PieApiError(response)
  }
  return response.data
}

export function apiGet<T>(path: string): Promise<T> {
  return call('GET', path) as Promise<T>
}

// Create/action POST — Idempotency-Key makes a retry safe; pass an etag for a
// `:transition`/`:approve` that guards on the current version (OCC).
export function apiPost<T>(path: string, body?: unknown, etag?: string): Promise<T> {
  return call('POST', path, {
    body,
    idempotencyKey: randomId(),
    ...(etag ? { ifMatch: etag } : {})
  }) as Promise<T>
}

export function apiPostWithIdempotencyKey<T>(
  path: string,
  body: unknown,
  idempotencyKey: string
): Promise<T> {
  return call('POST', path, { body, idempotencyKey }) as Promise<T>
}

// OCC update — the etag guards against a stale write (409/428).
export function apiPatch<T>(path: string, body: unknown, etag: string): Promise<T> {
  return call('PATCH', path, {
    body,
    ifMatch: etag,
    idempotencyKey: randomId()
  }) as Promise<T>
}

export function apiDelete(path: string): Promise<void> {
  return call('DELETE', path) as Promise<void>
}
