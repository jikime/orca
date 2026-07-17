import { z } from 'zod'

import {
  ArtifactSchema,
  ClassificationSchema,
  CommentSchema,
  ExecutionHostSchema,
  ProjectSchema,
  VisibilitySchema,
  WorkItemSchema,
  cursorSchema,
  idempotencyKeySchema,
  nullableId,
  opaqueIdSchema,
  resourceVersionSchema
} from './pie-mcp-resource-schemas'

// Input schemas are strict() so an unexpected key (e.g. a smuggled `accessToken`)
// is rejected — the input JSON schemas set additionalProperties:false. Output
// schemas passthrough for forward-compat.

export const ProjectsListInputSchema = z
  .object({
    query: z.string().max(200).optional(),
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(50).optional()
  })
  .strict()

export const ProjectsListOutputSchema = z.object({
  items: z.array(ProjectSchema).max(50),
  nextCursor: z.union([cursorSchema, z.null()])
})

export const WorkItemGetInputSchema = z.object({ workItemId: opaqueIdSchema }).strict()

export const WorkItemGetOutputSchema = z.object({ workItem: WorkItemSchema })

export const WorkItemsSearchInputSchema = z
  .object({
    query: z.string().min(1).max(500),
    projectId: opaqueIdSchema.optional(),
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(50).optional()
  })
  .strict()

export const WorkItemsSearchOutputSchema = z.object({
  items: z.array(WorkItemSchema).max(50),
  nextCursor: z.union([cursorSchema, z.null()])
})

export const WorkItemCommentCreateInputSchema = z
  .object({
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    body: z.string().min(1).max(20000),
    visibility: VisibilitySchema,
    expectedVersion: resourceVersionSchema,
    idempotencyKey: idempotencyKeySchema
  })
  .strict()

export const WorkItemCommentCreateOutputSchema = z.object({
  comment: CommentSchema,
  workItemVersion: resourceVersionSchema,
  correlationId: opaqueIdSchema
})

export const ArtifactRegisterInputSchema = z
  .object({
    projectId: opaqueIdSchema,
    workItemId: nullableId,
    runtimeArtifactId: opaqueIdSchema,
    name: z.string().min(1).max(255),
    classification: ClassificationSchema,
    visibility: VisibilitySchema,
    expectedVersion: resourceVersionSchema,
    idempotencyKey: idempotencyKeySchema
  })
  .strict()

export const ArtifactRegisterOutputSchema = z.object({
  artifact: ArtifactSchema,
  correlationId: opaqueIdSchema
})

export const ExecutionContextGetInputSchema = z.object({}).strict()

export const ExecutionContextGetOutputSchema = z
  .object({
    bound: z.boolean(),
    projectId: nullableId,
    workItemId: nullableId,
    workspaceId: nullableId,
    agentSessionId: nullableId,
    host: ExecutionHostSchema
  })
  .passthrough()

export type ProjectsListOutput = z.infer<typeof ProjectsListOutputSchema>
export type WorkItemGetOutput = z.infer<typeof WorkItemGetOutputSchema>
export type WorkItemsSearchOutput = z.infer<typeof WorkItemsSearchOutputSchema>
export type WorkItemCommentCreateInput = z.infer<typeof WorkItemCommentCreateInputSchema>
export type WorkItemCommentCreateOutput = z.infer<typeof WorkItemCommentCreateOutputSchema>
export type ArtifactRegisterInput = z.infer<typeof ArtifactRegisterInputSchema>
export type ArtifactRegisterOutput = z.infer<typeof ArtifactRegisterOutputSchema>
export type ExecutionContextGetOutput = z.infer<typeof ExecutionContextGetOutputSchema>

// No-token-passthrough guard: auth comes only from the local session, never from
// tool arguments. Scanned deeply so a nested credential key is caught too.
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'token',
  'authorization',
  'bearer',
  'apikey',
  'secret',
  'clientsecret',
  'password'
])

export function findCredentialField(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCredentialField(item)
      if (found) {
        return found
      }
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_CREDENTIAL_KEYS.has(key.toLowerCase())) {
        return key
      }
      const found = findCredentialField(nested)
      if (found) {
        return found
      }
    }
  }
  return null
}
