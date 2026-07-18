import type { IpcRenderer } from 'electron'
import {
  PIE_CONTROL_PLANE_CALL_CHANNEL,
  type PieControlPlaneRendererApi,
  type PieControlPlaneRequest,
  type PieControlPlaneResponse
} from '../shared/pie-control-plane-ipc'

type PieControlPlaneIpcRenderer = Pick<IpcRenderer, 'invoke'>

// Thin, zod-free forwarder: the sandboxed preload only relays the org-relative
// request to Main, which holds the token and performs validation + the fetch.
export function createPieControlPlanePreloadApi(
  ipc: PieControlPlaneIpcRenderer
): PieControlPlaneRendererApi {
  return {
    call: (request: PieControlPlaneRequest) =>
      ipc.invoke(PIE_CONTROL_PLANE_CALL_CHANNEL, request) as Promise<PieControlPlaneResponse>
  }
}
