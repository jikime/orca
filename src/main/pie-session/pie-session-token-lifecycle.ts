import type { PieSessionState } from '../../shared/pie-session-contract'
import type { DesktopSessionBroker } from './desktop-session-broker'
import {
  PieSessionSecretScopeSchema,
  pieSessionSecretScopeKey,
  type PieSessionSecretSaveResult,
  type PieSessionSecretScope,
  type SessionSecretStore
} from './session-secret-store'

export type PieSessionLoginInput = {
  scope: PieSessionSecretScope
  sessionId: string
  session: PieSessionState
  accessToken: string
  refreshToken: string
}

export type PieSessionRotationInput = {
  scope: PieSessionSecretScope
  accessToken: string
  refreshToken: string
}

/**
 * Connects the auth flow to secret storage. Access tokens never leave Main
 * memory; only the refresh token is handed to the SessionSecretStore. The
 * signed-in UI state is published through the DesktopSessionBroker, which
 * already rejects token-shaped fields.
 */
export class PieSessionTokenLifecycle {
  readonly #accessTokens = new Map<string, string>()
  #activeScopeKey: string | null = null

  constructor(
    private readonly store: SessionSecretStore,
    private readonly broker: DesktopSessionBroker,
    private readonly now: () => number = Date.now
  ) {}

  handleLoginSuccess(input: PieSessionLoginInput): PieSessionSecretSaveResult {
    const scope = PieSessionSecretScopeSchema.parse(input.scope)
    if (input.session.status === 'signed_out') {
      throw new Error('Pie login requires a signed-in session state')
    }
    if (scope.instanceId !== input.session.instanceId) {
      throw new Error('Pie login scope does not match the session instance')
    }
    if (scope.accountId !== input.session.userId) {
      throw new Error('Pie login scope does not match the session account')
    }

    const scopeKey = pieSessionSecretScopeKey(scope)
    this.#accessTokens.set(scopeKey, input.accessToken)
    this.#activeScopeKey = scopeKey
    const persistence = this.store.save(scope, {
      refreshToken: input.refreshToken,
      savedAt: this.now()
    })
    this.broker.replaceSession({ session: input.session, sessionId: input.sessionId })
    return persistence
  }

  handleTokenRotation(input: PieSessionRotationInput): PieSessionSecretSaveResult {
    const scope = PieSessionSecretScopeSchema.parse(input.scope)
    const scopeKey = pieSessionSecretScopeKey(scope)
    // Why: rotation is only valid for the account that is actually signed in;
    // a stale async refresh for another account must not overwrite its secret.
    if (scopeKey !== this.#activeScopeKey) {
      throw new Error('Pie token rotation requires the active signed-in account')
    }
    this.#accessTokens.set(scopeKey, input.accessToken)
    return this.store.save(scope, {
      refreshToken: input.refreshToken,
      savedAt: this.now()
    })
  }

  handleOrganizationSwitch(scope: PieSessionSecretScope, session: PieSessionState): void {
    const scopeKey = pieSessionSecretScopeKey(PieSessionSecretScopeSchema.parse(scope))
    // Why: switching organizations re-scopes claims for the SAME account only.
    // It never reads the secret store, so it can never adopt another account's
    // refresh token.
    if (scopeKey !== this.#activeScopeKey) {
      throw new Error('Pie organization switch requires the active signed-in account')
    }
    if (session.status === 'signed_out' || session.userId !== scope.accountId) {
      throw new Error('Pie organization switch cannot change the signed-in account')
    }
    this.broker.replaceSession({ session, sessionId: this.broker.getContext().sessionId })
  }

  handleLogout(scope: PieSessionSecretScope): void {
    this.#forgetScope(PieSessionSecretScopeSchema.parse(scope), 'delete')
  }

  handleAccountRemoved(scope: PieSessionSecretScope): void {
    this.#forgetScope(PieSessionSecretScopeSchema.parse(scope), 'clearAccount')
  }

  getAccessToken(scope: PieSessionSecretScope): string | null {
    return this.#accessTokens.get(pieSessionSecretScopeKey(scope)) ?? null
  }

  #forgetScope(scope: PieSessionSecretScope, removal: 'delete' | 'clearAccount'): void {
    const scopeKey = pieSessionSecretScopeKey(scope)
    this.#accessTokens.delete(scopeKey)
    if (removal === 'clearAccount') {
      this.store.clearAccount(scope)
    } else {
      this.store.delete(scope)
    }
    if (this.#activeScopeKey === scopeKey) {
      this.#activeScopeKey = null
      this.broker.replaceSession({
        session: { status: 'signed_out', instanceId: this.broker.getContext().instanceId },
        sessionId: null
      })
    }
  }
}
