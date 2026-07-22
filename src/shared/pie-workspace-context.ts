import { z } from 'zod'

export const PIE_WORKSPACE_CONTEXT_SCHEMA_VERSION = 1 as const

export const PieWorkspaceContextSchema = z
  .object({
    schemaVersion: z.literal(PIE_WORKSPACE_CONTEXT_SCHEMA_VERSION),
    authority: z.literal('pie'),
    organizationId: z.string().uuid(),
    projectId: z.string().uuid(),
    projectName: z.string().trim().min(1).max(200).optional(),
    workItemId: z.string().uuid(),
    workItemIdentifier: z.string().trim().min(1).max(120),
    workItemTitle: z.string().trim().min(1).max(500)
  })
  .strict()

export type PieWorkspaceContext = z.infer<typeof PieWorkspaceContextSchema>

export function parsePieWorkspaceContext(value: unknown): PieWorkspaceContext | null {
  const parsed = PieWorkspaceContextSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function isSamePieWorkspaceContext(
  left: Pick<PieWorkspaceContext, 'organizationId' | 'workItemId'>,
  right: Pick<PieWorkspaceContext, 'organizationId' | 'workItemId'>
): boolean {
  // Why: opaque WorkItem IDs are tenant-scoped, so both values are required to
  // compare bindings without relying on mutable titles, keys, or host paths.
  return left.organizationId === right.organizationId && left.workItemId === right.workItemId
}
