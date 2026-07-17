import { ipcMain } from 'electron'
import { getPieAuthService } from '../pie-auth/pie-auth-service-registry'
import { assertTrustedPieMainFrame } from './pie-renderer-trust'

// Renderer trigger for the dev-gated OIDC/PKCE login. login() opens the system
// browser and resolves once the loopback callback establishes the session; the
// session broker publishes the change, so the caller just re-reads getState().
export const PIE_AUTH_BEGIN_LOGIN_CHANNEL = 'pie:auth:begin-login'

export function registerPieAuthLoginHandlers(): void {
  ipcMain.handle(PIE_AUTH_BEGIN_LOGIN_CHANNEL, async (event) => {
    assertTrustedPieMainFrame(event)
    const service = getPieAuthService()
    if (!service) {
      throw new Error('pie-auth is not enabled (set PIE_AUTH_DISCOVERY_URL)')
    }
    await service.login()
  })
}
