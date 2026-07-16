import { app, ipcMain } from 'electron'
import { PIE_RUNTIME_GET_HANDSHAKE_CHANNEL } from '../../shared/pie-runtime-handshake-contract'
import type { DesktopSessionBroker } from '../pie-session/desktop-session-broker'
import {
  PieRuntimeHandshakeEndpoint,
  type PieRuntimeHandshakeIdentity
} from '../runtime/pie-runtime-handshake'
import { assertTrustedPieMainFrame } from './pie-renderer-trust'

export function registerPieRuntimeHandlers(
  runtime: PieRuntimeHandshakeIdentity,
  sessionBroker: DesktopSessionBroker
): void {
  const handshake = new PieRuntimeHandshakeEndpoint({
    runtime,
    runtimeVersion: app.getVersion(),
    getSessionContext: () => sessionBroker.getContext()
  })

  ipcMain.removeHandler(PIE_RUNTIME_GET_HANDSHAKE_CHANNEL)
  ipcMain.handle(PIE_RUNTIME_GET_HANDSHAKE_CHANNEL, (event, input?: unknown) => {
    assertTrustedPieMainFrame(event)
    if (input !== undefined) {
      throw new Error('PIE_IPC_INVALID_REQUEST')
    }
    return handshake.performHandshake(app.getVersion())
  })
}
