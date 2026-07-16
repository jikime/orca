import { ipcMain, webContents } from 'electron'
import {
  PIE_SESSION_CHANGED_CHANNEL,
  PIE_SESSION_GET_STATE_CHANNEL,
  PIE_SESSION_PROTOCOL_VERSION,
  PieSessionGetRequestSchema,
  PieSessionGetResponseSchema
} from '../../shared/pie-session-contract'
import type { DesktopSessionBroker } from '../pie-session/desktop-session-broker'
import { assertTrustedPieMainFrame, getTrustedPieRendererWebContentsId } from './pie-renderer-trust'

let unsubscribeFromSessionChanges: (() => void) | null = null

function assertBootstrapContext(
  requestContext: { instanceId: string; sessionId: string | null; organizationId: string | null },
  broker: DesktopSessionBroker
): void {
  const activeContext = broker.getContext()
  // Why: getState is the bootstrap call, so the renderer cannot assert a user,
  // session, or organization before Main has returned the current state.
  if (
    requestContext.instanceId !== activeContext.instanceId ||
    requestContext.sessionId !== null ||
    requestContext.organizationId !== null
  ) {
    throw new Error('PIE_IPC_SESSION_CONTEXT_MISMATCH')
  }
}

export function registerPieSessionHandlers(broker: DesktopSessionBroker): void {
  ipcMain.removeHandler(PIE_SESSION_GET_STATE_CHANNEL)
  ipcMain.handle(PIE_SESSION_GET_STATE_CHANNEL, (event, input: unknown) => {
    assertTrustedPieMainFrame(event)
    const parsed = PieSessionGetRequestSchema.safeParse(input)
    if (!parsed.success) {
      throw new Error('PIE_IPC_INVALID_REQUEST')
    }
    assertBootstrapContext(parsed.data.sessionContext, broker)
    return PieSessionGetResponseSchema.parse({
      requestId: parsed.data.requestId,
      protocolVersion: PIE_SESSION_PROTOCOL_VERSION,
      ok: true,
      result: broker.getState()
    })
  })

  unsubscribeFromSessionChanges?.()
  unsubscribeFromSessionChanges = broker.subscribe((event) => {
    const trustedRendererWebContentsId = getTrustedPieRendererWebContentsId()
    if (trustedRendererWebContentsId === null) {
      return
    }
    const renderer = webContents.fromId(trustedRendererWebContentsId)
    if (!renderer || renderer.isDestroyed()) {
      return
    }
    renderer.send(PIE_SESSION_CHANGED_CHANNEL, event)
  })
}
