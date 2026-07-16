import {
  PIE_LOCAL_INSTANCE_ID,
  PIE_SESSION_PROTOCOL_VERSION,
  PieSessionChangedSchema,
  PieSessionContextSchema,
  PieSessionStateSchema,
  type PieSessionChanged,
  type PieSessionContext,
  type PieSessionState
} from '../../shared/pie-session-contract'

export type DesktopSessionTransition = {
  session: PieSessionState
  sessionId: string | null
}

export type DesktopSessionBroker = {
  getContext: () => PieSessionContext
  getState: () => PieSessionState
  replaceSession: (transition: DesktopSessionTransition) => void
  subscribe: (listener: (event: PieSessionChanged) => void) => () => void
}

function cloneSessionState(session: PieSessionState): PieSessionState {
  return structuredClone(session)
}

export class InMemoryDesktopSessionBroker implements DesktopSessionBroker {
  readonly #instanceId: string
  readonly #listeners = new Set<(event: PieSessionChanged) => void>()
  #sequence = 0
  #session: PieSessionState
  #sessionId: string | null = null

  constructor(instanceId = PIE_LOCAL_INSTANCE_ID) {
    this.#instanceId = PieSessionContextSchema.shape.instanceId.parse(instanceId)
    this.#session = PieSessionStateSchema.parse({ status: 'signed_out', instanceId })
  }

  getContext(): PieSessionContext {
    return {
      instanceId: this.#instanceId,
      sessionId: this.#sessionId,
      organizationId: this.#session.status === 'signed_out' ? null : this.#session.organizationId
    }
  }

  getState(): PieSessionState {
    return cloneSessionState(this.#session)
  }

  replaceSession(transition: DesktopSessionTransition): void {
    const session = PieSessionStateSchema.parse(transition.session)
    const context = PieSessionContextSchema.parse({
      instanceId: this.#instanceId,
      sessionId: transition.sessionId,
      organizationId: session.status === 'signed_out' ? null : session.organizationId
    })
    const isSignedOut = session.status === 'signed_out'
    if (isSignedOut !== (context.sessionId === null)) {
      throw new Error('Signed-in Pie sessions require a session ID')
    }
    if (session.instanceId !== this.#instanceId) {
      throw new Error('Pie session instance does not match the active broker')
    }

    this.#session = cloneSessionState(session)
    this.#sessionId = context.sessionId
    this.#sequence += 1
    const event = PieSessionChangedSchema.parse({
      type: 'session.changed',
      protocolVersion: PIE_SESSION_PROTOCOL_VERSION,
      sequence: this.#sequence,
      session: this.#session
    })
    for (const listener of this.#listeners) {
      listener(event)
    }
  }

  subscribe(listener: (event: PieSessionChanged) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}

export const desktopSessionBroker = new InMemoryDesktopSessionBroker()
