import type { IpcRenderer } from 'electron'
import {
  PIE_RUNTIME_GET_HANDSHAKE_CHANNEL,
  PieRuntimeHandshakeResponseSchema,
  type PieRuntimeRendererApi
} from '../shared/pie-runtime-handshake-contract'

type PieRuntimeIpcRenderer = Pick<IpcRenderer, 'invoke'>

export function createPieRuntimePreloadApi(ipc: PieRuntimeIpcRenderer): PieRuntimeRendererApi {
  return {
    getHandshake: async () =>
      PieRuntimeHandshakeResponseSchema.parse(await ipc.invoke(PIE_RUNTIME_GET_HANDSHAKE_CHANNEL))
  }
}
