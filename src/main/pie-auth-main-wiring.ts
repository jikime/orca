import { app, safeStorage, shell } from 'electron'
import { desktopSessionBroker } from './pie-session/desktop-session-broker'
import { PieSessionTokenLifecycle } from './pie-session/pie-session-token-lifecycle'
import { SafeStorageSessionSecretStore } from './pie-session/safe-storage-session-secret-store'
import { initPieAuthServiceIfEnabled, stopPieAuthService } from './pie-auth/pie-auth-service'

// Electron composition root for the OIDC/PKCE login service. Kept out of the
// pie-auth/ core so that core stays electron-free and unit-testable. Dev-gated:
// initPieAuthServiceIfEnabled is a no-op unless PIE_AUTH_DISCOVERY_URL is set and
// safe mode has not disabled 'pie-auth'. Login is triggered explicitly (no
// production auto-start); this only makes the service available.
export function startPieAuthMainIfEnabled(): void {
  const store = new SafeStorageSessionSecretStore({
    safeStorage,
    getUserDataPath: () => app.getPath('userData')
  })
  const lifecycle = new PieSessionTokenLifecycle(store, desktopSessionBroker)
  initPieAuthServiceIfEnabled({
    // System browser only — the service never embeds a webview (RFC 8252).
    openAuthorizationUrl: (url) => shell.openExternal(url),
    lifecycle,
    store,
    sessionBroker: desktopSessionBroker
  })
}

export { stopPieAuthService }
