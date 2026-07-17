import {
  AgentEventBatchResponseSchema,
  type AgentEventBatchRequest,
  type AgentEventBatchResponse
} from '../../shared/agent-event-batch-contract'

// Thin authed client for the R5 s1 batch ingest endpoint. Mirrors chat-control-plane-client:
// the access token is a bearer that never appears in a log/error line, and a batch-level
// Idempotency-Key makes a retried POST safe (the server replays the prior outcome). apiBaseUrl
// already includes /v1. The base URL + token are resolved from the pie-auth registry via
// injected getters so a revoked/rotated login is reflected on the very next batch (CAP-006).

export class AgentEventUploadError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'AgentEventUploadError'
    this.status = status
  }
}

export type AgentEventUploadClient = {
  upload(
    organizationId: string,
    batch: AgentEventBatchRequest,
    idempotencyKey: string
  ): Promise<AgentEventBatchResponse>
}

export type AgentEventUploadClientDeps = {
  getApiBaseUrl: () => string | null
  getAccessToken: () => string | null
  fetchImpl?: typeof fetch
}

function batchUrl(apiBaseUrl: string, organizationId: string): string {
  // Static colon-suffixed org action; the server captures the 3rd segment and matches the token.
  return `${apiBaseUrl}/organizations/${organizationId}/agent-events:batch`
}

export function createAgentEventUploadClient(
  deps: AgentEventUploadClientDeps
): AgentEventUploadClient {
  const fetchImpl = deps.fetchImpl ?? fetch
  return {
    async upload(organizationId, batch, idempotencyKey) {
      const apiBaseUrl = deps.getApiBaseUrl()
      const accessToken = deps.getAccessToken()
      if (!apiBaseUrl || !accessToken) {
        // Signed out / no base URL: refuse to build an unauthenticated request.
        throw new AgentEventUploadError('not authenticated for agent-event upload')
      }
      const response = await fetchImpl(batchUrl(apiBaseUrl, organizationId), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey
        },
        body: JSON.stringify(batch)
      })
      if (!response.ok) {
        throw new AgentEventUploadError(
          `agent-event batch failed with ${response.status}`,
          response.status
        )
      }
      const parsed = AgentEventBatchResponseSchema.safeParse(await response.json())
      if (!parsed.success) {
        throw new AgentEventUploadError('agent-event batch response failed schema validation')
      }
      return parsed.data
    }
  }
}
