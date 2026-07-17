// R5 slice 2b: BYTE-IDENTICAL MIRROR of the client's execution-context canonical form
// (root src/shared/execution-context-contract.ts). The platform workspace cannot import root
// src/shared, so this mirror carries the same frozen serializer; a shared golden fixture that BOTH
// sides verify (execution-context-canonical.golden.test.ts here + execution-context-signer.test.ts
// on the client) fails if the two ever drift. Platform has no zod dependency, so validation here is
// hand-written rather than schema-derived. Mirrors the relay-wire type-mirror precedent.

export const EXECUTION_CONTEXT_SCHEMA_VERSION = 1 as const

export type ExecutionContextHostType = 'native' | 'wsl' | 'ssh'

export type ExecutionContext = {
  schemaVersion: typeof EXECUTION_CONTEXT_SCHEMA_VERSION
  installationId: string
  hostType: ExecutionContextHostType
  hostId: string
  workspacePath: string
  launchId: string
  agentSessionId: string
  provider: string
  notBefore: number
  notAfter: number
}

export type SignedExecutionContext = {
  context: ExecutionContext
  installationId: string
  signature: string
  publicKeyId: string
}

// FROZEN field order + encoding — must match the client serializer byte-for-byte or Ed25519
// verification across the workspace boundary fails. Do not reorder/reformat without bumping
// schemaVersion and the golden fixture on BOTH sides.
export function canonicalizeExecutionContext(context: ExecutionContext): string {
  const parts = [
    `"schemaVersion":${JSON.stringify(context.schemaVersion)}`,
    `"installationId":${JSON.stringify(context.installationId)}`,
    `"hostType":${JSON.stringify(context.hostType)}`,
    `"hostId":${JSON.stringify(context.hostId)}`,
    `"workspacePath":${JSON.stringify(context.workspacePath)}`,
    `"launchId":${JSON.stringify(context.launchId)}`,
    `"agentSessionId":${JSON.stringify(context.agentSessionId)}`,
    `"provider":${JSON.stringify(context.provider)}`,
    `"notBefore":${JSON.stringify(context.notBefore)}`,
    `"notAfter":${JSON.stringify(context.notAfter)}`
  ]
  return `{${parts.join(',')}}`
}

export function executionContextSigningBytes(context: ExecutionContext): Buffer {
  return Buffer.from(canonicalizeExecutionContext(context), 'utf-8')
}

export function isExecutionContextWithinWindow(context: ExecutionContext, atMs: number): boolean {
  return atMs >= context.notBefore && atMs <= context.notAfter
}

const HOST_TYPES: readonly ExecutionContextHostType[] = ['native', 'wsl', 'ssh']

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

// Hand-written structural guard (no zod on platform). The route's Ajv schema already validates the
// wire shape, but persistence re-guards so a signed context is never trusted on shape alone.
export function parseSignedExecutionContext(value: unknown): SignedExecutionContext | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const outer = value as Record<string, unknown>
  if (
    !isNonEmptyString(outer.installationId) ||
    !isNonEmptyString(outer.signature) ||
    !isNonEmptyString(outer.publicKeyId) ||
    !outer.context ||
    typeof outer.context !== 'object'
  ) {
    return null
  }
  const context = outer.context as Record<string, unknown>
  if (
    context.schemaVersion !== EXECUTION_CONTEXT_SCHEMA_VERSION ||
    !isNonEmptyString(context.installationId) ||
    !isNonEmptyString(context.hostType) ||
    !HOST_TYPES.includes(context.hostType as ExecutionContextHostType) ||
    !isNonEmptyString(context.hostId) ||
    !isNonEmptyString(context.workspacePath) ||
    !isNonEmptyString(context.launchId) ||
    !isNonEmptyString(context.agentSessionId) ||
    !isNonEmptyString(context.provider) ||
    !isNonNegativeInt(context.notBefore) ||
    !isNonNegativeInt(context.notAfter)
  ) {
    return null
  }
  return {
    context: {
      schemaVersion: EXECUTION_CONTEXT_SCHEMA_VERSION,
      installationId: context.installationId,
      hostType: context.hostType as ExecutionContextHostType,
      hostId: context.hostId,
      workspacePath: context.workspacePath,
      launchId: context.launchId,
      agentSessionId: context.agentSessionId,
      provider: context.provider,
      notBefore: context.notBefore,
      notAfter: context.notAfter
    },
    installationId: outer.installationId,
    signature: outer.signature,
    publicKeyId: outer.publicKeyId
  }
}
