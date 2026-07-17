import { z } from 'zod'

// zod mirrors of contracts/schemas/common + resources used by the Pie MCP tools.
// Kept in lockstep with the frozen JSON schemas; pie-mcp-contract-conformance.test.ts
// re-validates produced output against the JSON schema files to catch drift.

export const opaqueIdSchema = z.string().uuid()
export const cursorSchema = z.string().min(1).max(512)
export const resourceVersionSchema = z.number().int().min(1)
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const VisibilitySchema = z.enum(['internal', 'project', 'customer'])
export const ClassificationSchema = z.enum([
  'public',
  'internal',
  'project_confidential',
  'restricted'
])

const nullableId = z.union([opaqueIdSchema, z.null()])

// Passthrough everywhere output is mirrored: an additive optional field from a
// newer control-plane must not fail client validation (forward-compat).
export const ExecutionHostSchema = z
  .object({
    hostId: opaqueIdSchema,
    type: z.enum(['native', 'wsl', 'ssh', 'relay']),
    platform: z.enum(['darwin', 'linux', 'win32']),
    pathStyle: z.enum(['posix', 'windows']),
    caseSensitivePaths: z.boolean(),
    connectionId: z.string().max(256).nullable().optional(),
    wslDistribution: z.string().max(128).nullable().optional()
  })
  .passthrough()

export const ProjectSchema = z
  .object({
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    name: z.string().min(1).max(200),
    summary: z.string().max(2000).nullable().optional(),
    status: z.enum(['planned', 'active', 'paused', 'completed', 'cancelled']),
    version: resourceVersionSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    archivedAt: z.string().nullable().optional()
  })
  .passthrough()

export const WorkItemSchema = z
  .object({
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    teamId: opaqueIdSchema,
    projectId: nullableId,
    identifier: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/),
    title: z.string().min(1).max(500),
    description: z.string().max(100000).nullable().optional(),
    stateId: opaqueIdSchema,
    workflowVersion: resourceVersionSchema.optional(),
    sortKey: z.number().int().optional(),
    priority: z.enum(['none', 'urgent', 'high', 'medium', 'low']),
    assigneeId: nullableId.optional(),
    version: resourceVersionSchema,
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .passthrough()

export const CommentSchema = z
  .object({
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    authorId: opaqueIdSchema,
    body: z.string().min(1).max(20000),
    visibility: VisibilitySchema,
    createdAt: z.string()
  })
  .passthrough()

const ObjectReferenceSchema = z
  .object({
    objectId: opaqueIdSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().min(0)
  })
  .passthrough()

export const ArtifactSchema = z
  .object({
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: nullableId,
    name: z.string().min(1).max(255),
    classification: ClassificationSchema,
    visibility: VisibilitySchema,
    status: z.enum(['pending_upload', 'available', 'quarantined', 'rejected']),
    revision: z.number().int().min(1),
    object: z.union([ObjectReferenceSchema, z.null()]).optional(),
    version: resourceVersionSchema,
    createdAt: z.string()
  })
  .passthrough()

export { nullableId }
