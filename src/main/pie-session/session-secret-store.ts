import { createHash } from 'node:crypto'
import { z } from 'zod'

const scopeIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]+$/)

export const PieSessionSecretScopeSchema = z
  .object({
    instanceId: scopeIdSchema,
    profileId: scopeIdSchema,
    accountId: scopeIdSchema
  })
  .strict()

export type PieSessionSecretScope = z.infer<typeof PieSessionSecretScopeSchema>

export const PieSessionSecretSchema = z
  .object({
    refreshToken: z.string().min(1).max(8_192),
    savedAt: z.number().int().nonnegative()
  })
  .strict()

export type PieSessionSecret = z.infer<typeof PieSessionSecretSchema>

export type PieSessionSecretSaveResult =
  | { status: 'persisted' }
  | { status: 'persistent-login-unavailable'; reason: string }

export type PieSessionSecretReadResult =
  | { status: 'found'; secret: PieSessionSecret }
  | { status: 'missing' }
  // Why: undecryptable ciphertext is discarded on read so a tampered or
  // key-rotated file cannot wedge the account; the caller must re-login.
  | { status: 'discarded-corrupt' }
  | { status: 'persistent-login-unavailable'; reason: string }

/**
 * Main-process-only storage for Pie session secrets. Only the refresh token is
 * ever persisted; access tokens live in Main memory. Implementations must never
 * expose this contract (or raw tokens) through preload or renderer IPC.
 */
export type SessionSecretStore = {
  save: (scope: PieSessionSecretScope, secret: PieSessionSecret) => PieSessionSecretSaveResult
  read: (scope: PieSessionSecretScope) => PieSessionSecretReadResult
  delete: (scope: PieSessionSecretScope) => void
  clearAccount: (scope: PieSessionSecretScope) => void
}

// Why: scope IDs are user-influenced (instance discovery, IdP subject). Hashing
// each segment removes path-traversal surface and keeps distinct IDs distinct on
// case-insensitive filesystems (macOS/Windows) where "Acme" and "acme" collide.
export function pieSessionSecretScopeSegment(id: string): string {
  return createHash('sha256').update(id, 'utf-8').digest('hex').slice(0, 32)
}

export function pieSessionSecretScopeKey(scope: PieSessionSecretScope): string {
  const parsed = PieSessionSecretScopeSchema.parse(scope)
  return [
    pieSessionSecretScopeSegment(parsed.instanceId),
    pieSessionSecretScopeSegment(parsed.profileId),
    pieSessionSecretScopeSegment(parsed.accountId)
  ].join('/')
}
