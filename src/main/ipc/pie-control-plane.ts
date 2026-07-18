import { ipcMain } from 'electron'
import {
  PIE_CONTROL_PLANE_CALL_CHANNEL,
  type PieControlPlaneMethod,
  type PieControlPlaneRequest,
  type PieControlPlaneResponse
} from '../../shared/pie-control-plane-ipc'
import { makeAuthedFetch } from '../pie-chat/chat-auth-retry'
import { assertTrustedPieMainFrame } from './pie-renderer-trust'

export type PieControlPlaneDeps = {
  getApiBaseUrl: () => string | null
  getAccessToken: () => string | null
  getOrganizationId: () => string | null
  forceRefresh: () => Promise<boolean>
  fetchImpl?: typeof fetch
}

const ALLOWED_METHODS: readonly PieControlPlaneMethod[] = ['GET', 'POST', 'PATCH', 'DELETE']

// The renderer may only reach its own org's control-plane: the path is appended
// to `${apiBaseUrl}/organizations/${orgId}`, so it can't escape to another host
// or org. Reject anything that isn't a plain org-relative path.
function assertOrgRelativePath(path: unknown): string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.includes('://') ||
    path.includes('..')
  ) {
    throw new Error('PIE_CP_INVALID_PATH')
  }
  return path
}

function assertMethod(method: unknown): PieControlPlaneMethod {
  if (typeof method !== 'string' || !ALLOWED_METHODS.includes(method as PieControlPlaneMethod)) {
    throw new Error('PIE_CP_INVALID_METHOD')
  }
  return method as PieControlPlaneMethod
}

export function registerPieControlPlaneHandlers(deps: PieControlPlaneDeps): void {
  // The token never leaves Main; the authed fetch refreshes it on a 401 and retries.
  const authedFetch =
    deps.fetchImpl ??
    makeAuthedFetch(fetch, {
      forceRefresh: deps.forceRefresh,
      getAccessToken: deps.getAccessToken
    })

  ipcMain.removeHandler(PIE_CONTROL_PLANE_CALL_CHANNEL)
  ipcMain.handle(
    PIE_CONTROL_PLANE_CALL_CHANNEL,
    async (event, input: unknown): Promise<PieControlPlaneResponse> => {
      assertTrustedPieMainFrame(event)
      const request = input as PieControlPlaneRequest
      const method = assertMethod(request?.method)
      const path = assertOrgRelativePath(request?.path)

      const apiBaseUrl = deps.getApiBaseUrl()
      const accessToken = deps.getAccessToken()
      const organizationId = deps.getOrganizationId()
      if (!apiBaseUrl || !accessToken || !organizationId) {
        return { ok: false, status: 401, data: { error: 'PIE_NOT_AUTHENTICATED' } }
      }

      const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` }
      if (request.ifMatch) {
        headers['if-match'] = request.ifMatch
      }
      if (request.idempotencyKey) {
        headers['idempotency-key'] = request.idempotencyKey
      }
      const hasBody = request.body !== undefined && method !== 'GET'
      if (hasBody) {
        headers['content-type'] = 'application/json'
      }

      const response = await authedFetch(`${apiBaseUrl}/organizations/${organizationId}${path}`, {
        method,
        headers,
        ...(hasBody ? { body: JSON.stringify(request.body) } : {})
      })
      // 204/empty bodies parse to null; everything else is JSON.
      const text = await response.text()
      const data = text.length > 0 ? JSON.parse(text) : null
      return { ok: response.ok, status: response.status, data }
    }
  )
}
