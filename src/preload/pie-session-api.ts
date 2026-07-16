import type { IpcRenderer, IpcRendererEvent } from 'electron'
import {
  PIE_LOCAL_INSTANCE_ID,
  PIE_SESSION_CHANGED_CHANNEL,
  PIE_SESSION_GET_STATE_CHANNEL,
  PIE_SESSION_PROTOCOL_VERSION,
  PieSessionChangedSchema,
  PieSessionGetRequestSchema,
  PieSessionGetResponseSchema,
  type PieSessionRendererApi
} from '../shared/pie-session-contract'

type PieSessionIpcRenderer = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>

export function createPieSessionPreloadApi(
  ipc: PieSessionIpcRenderer,
  createRequestId: () => string = () => globalThis.crypto.randomUUID()
): PieSessionRendererApi {
  return {
    getState: async () => {
      const request = PieSessionGetRequestSchema.parse({
        requestId: createRequestId(),
        method: 'session.getState',
        protocolVersion: PIE_SESSION_PROTOCOL_VERSION,
        sessionContext: {
          instanceId: PIE_LOCAL_INSTANCE_ID,
          sessionId: null,
          organizationId: null
        },
        payload: {}
      })
      const response = PieSessionGetResponseSchema.parse(
        await ipc.invoke(PIE_SESSION_GET_STATE_CHANNEL, request)
      )
      if (!response.ok) {
        throw new Error(response.problem.code)
      }
      return response.result
    },
    onChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, input: unknown): void => {
        const parsed = PieSessionChangedSchema.safeParse(input)
        if (parsed.success) {
          callback(parsed.data)
        }
      }
      ipc.on(PIE_SESSION_CHANGED_CHANNEL, listener)
      return () => ipc.removeListener(PIE_SESSION_CHANGED_CHANNEL, listener)
    }
  }
}
