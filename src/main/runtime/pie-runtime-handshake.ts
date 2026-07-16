import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  PIE_RUNTIME_PROTOCOL_VERSION,
  PieRuntimeHandshakeRequestSchema,
  PieRuntimeHandshakeResponseSchema,
  type PieRuntimeHandshakeRequest,
  type PieRuntimeHandshakeResponse
} from '../../shared/pie-runtime-handshake-contract'
import type { PieSessionContext } from '../../shared/pie-session-contract'

export type PieRuntimeHandshakeIdentity = {
  getRuntimeId: () => string
}

export type PieRuntimeHandshakeOptions = {
  runtime: PieRuntimeHandshakeIdentity
  runtimeVersion: string
  getSessionContext: () => PieSessionContext
  capability?: string
  hostId?: string
  sqliteVersion?: string
  platform?: NodeJS.Platform
}

function capabilitiesForRuntime(): string[] {
  return ['runtime.handshake_v1', 'runtime.bounded_streams']
}

function capabilitiesMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function contextsMatch(actual: PieSessionContext, expected: PieSessionContext): boolean {
  return (
    actual.instanceId === expected.instanceId &&
    actual.sessionId === expected.sessionId &&
    actual.organizationId === expected.organizationId
  )
}

export class PieRuntimeHandshakeEndpoint {
  readonly #capability: string
  readonly #getSessionContext: () => PieSessionContext
  readonly #hostId: string
  readonly #platform: NodeJS.Platform
  readonly #runtime: PieRuntimeHandshakeIdentity
  readonly #runtimeVersion: string
  readonly #sqliteVersion: string

  constructor(options: PieRuntimeHandshakeOptions) {
    this.#runtime = options.runtime
    this.#runtimeVersion = options.runtimeVersion
    this.#getSessionContext = options.getSessionContext
    this.#capability = options.capability ?? randomBytes(32).toString('base64url')
    this.#hostId = options.hostId ?? randomUUID()
    this.#sqliteVersion = options.sqliteVersion ?? process.versions.sqlite ?? '0.0.0'
    this.#platform = options.platform ?? process.platform
  }

  performHandshake(mainVersion: string): PieRuntimeHandshakeResponse {
    return this.negotiate({
      type: 'runtime.handshake',
      requestId: randomUUID(),
      mainVersion,
      supportedProtocolVersions: [PIE_RUNTIME_PROTOCOL_VERSION],
      sessionContext: this.#getSessionContext(),
      capability: this.#capability
    })
  }

  negotiate(input: unknown): PieRuntimeHandshakeResponse {
    const request = PieRuntimeHandshakeRequestSchema.safeParse(input)
    if (!request.success) {
      throw new Error('PIE_RUNTIME_INVALID_HANDSHAKE')
    }
    if (!capabilitiesMatch(request.data.capability, this.#capability)) {
      throw new Error('PIE_RUNTIME_CAPABILITY_DENIED')
    }
    if (!contextsMatch(request.data.sessionContext, this.#getSessionContext())) {
      throw new Error('PIE_RUNTIME_SESSION_CONTEXT_MISMATCH')
    }
    if (!request.data.supportedProtocolVersions.includes(PIE_RUNTIME_PROTOCOL_VERSION)) {
      throw new Error('PIE_RUNTIME_PROTOCOL_UNSUPPORTED')
    }
    return this.#welcome(request.data)
  }

  #welcome(request: PieRuntimeHandshakeRequest): PieRuntimeHandshakeResponse {
    const platform = this.#platform
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
      throw new Error('PIE_RUNTIME_PLATFORM_UNSUPPORTED')
    }
    return PieRuntimeHandshakeResponseSchema.parse({
      type: 'runtime.welcome',
      requestId: request.requestId,
      protocolVersion: PIE_RUNTIME_PROTOCOL_VERSION,
      runtimeId: this.#runtime.getRuntimeId(),
      runtimeVersion: this.#runtimeVersion,
      host: {
        hostId: this.#hostId,
        type: 'native',
        platform,
        pathStyle: platform === 'win32' ? 'windows' : 'posix',
        caseSensitivePaths: platform === 'linux'
      },
      sqliteVersion: this.#sqliteVersion,
      git: {
        baseline: '2.25',
        version: null,
        capabilities: []
      },
      providerParsers: {},
      capabilities: capabilitiesForRuntime(),
      limits: {
        maxRequestBytes: 1_048_576,
        maxFrameBytes: 262_144,
        maxConcurrentStreams: 16
      }
    })
  }
}
