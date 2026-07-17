import type { ZodType } from 'zod'

import {
  ArtifactRegisterInputSchema,
  ExecutionContextGetInputSchema,
  ProjectsListInputSchema,
  WorkItemCommentCreateInputSchema,
  WorkItemGetInputSchema,
  WorkItemsSearchInputSchema
} from './pie-mcp-tool-io-schemas'

// LOCAL stdio Pie MCP transport, MCP protocol revision 2025-11-25. Framing is
// newline-delimited JSON-RPC 2.0 per the MCP stdio spec (one message per line,
// no embedded newlines) — OS-neutral, no shell/Content-Length assumptions.
export const PIE_MCP_PROTOCOL_VERSION = '2025-11-25'
export const PIE_MCP_TRANSPORT = 'stdio'
export const PIE_MCP_SERVER_NAME = 'pie-local'

// Advertised JSON Schema for tools/list. Self-contained (no remote $ref) so an
// MCP client can consume it directly; the runtime zod mirror is authoritative.
type JsonSchema = Record<string, unknown>

const uuid: JsonSchema = { type: 'string', format: 'uuid' }
const cursor: JsonSchema = { type: 'string', minLength: 1, maxLength: 512 }
const limit: JsonSchema = { type: 'integer', minimum: 1, maximum: 50 }
const resourceVersion: JsonSchema = { type: 'integer', minimum: 1 }
const idempotencyKey: JsonSchema = {
  type: 'string',
  minLength: 8,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
}
const visibility: JsonSchema = { enum: ['internal', 'project', 'customer'] }
const classification: JsonSchema = {
  enum: ['public', 'internal', 'project_confidential', 'restricted']
}

export type PieMcpToolDescriptor = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly inputZod: ZodType
  readonly sideEffect: boolean
  readonly requiredPermissions: readonly string[]
  readonly requiresIdempotencyKey: boolean
  readonly requiresExpectedVersion: boolean
  readonly maxOutputBytes: number
}

// Mirrors contracts/manifests/mcp-tools.json exactly. pie-mcp-tool-registry.test.ts
// asserts this table against the manifest file so the two never drift.
export const PIE_MCP_TOOLS: readonly PieMcpToolDescriptor[] = [
  {
    name: 'pie.projects.list',
    description: 'List projects visible to the signed-in user in their organization.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', maxLength: 200 }, cursor, limit }
    },
    inputZod: ProjectsListInputSchema,
    sideEffect: false,
    requiredPermissions: ['mcp.project.read'],
    requiresIdempotencyKey: false,
    requiresExpectedVersion: false,
    maxOutputBytes: 262144
  },
  {
    name: 'pie.work_items.get',
    description: 'Fetch a single work item by id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workItemId'],
      properties: { workItemId: uuid }
    },
    inputZod: WorkItemGetInputSchema,
    sideEffect: false,
    requiredPermissions: ['mcp.work_item.read'],
    requiresIdempotencyKey: false,
    requiresExpectedVersion: false,
    maxOutputBytes: 131072
  },
  {
    name: 'pie.work_items.search',
    description: 'Search work items by free-text query, optionally scoped to a project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        projectId: uuid,
        cursor,
        limit
      }
    },
    inputZod: WorkItemsSearchInputSchema,
    sideEffect: false,
    requiredPermissions: ['mcp.work_item.read'],
    requiresIdempotencyKey: false,
    requiresExpectedVersion: false,
    maxOutputBytes: 262144
  },
  {
    name: 'pie.work_items.comment.create',
    description:
      'Add a comment to a work item (write; requires idempotency key and expected version).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'projectId',
        'workItemId',
        'body',
        'visibility',
        'expectedVersion',
        'idempotencyKey'
      ],
      properties: {
        projectId: uuid,
        workItemId: uuid,
        body: { type: 'string', minLength: 1, maxLength: 20000 },
        visibility,
        expectedVersion: resourceVersion,
        idempotencyKey
      }
    },
    inputZod: WorkItemCommentCreateInputSchema,
    sideEffect: true,
    requiredPermissions: ['mcp.work_item.write', 'work_item.comment'],
    requiresIdempotencyKey: true,
    requiresExpectedVersion: true,
    maxOutputBytes: 131072
  },
  {
    name: 'pie.artifacts.register',
    description:
      'Register runtime artifact metadata (write; requires idempotency key and expected version).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'projectId',
        'workItemId',
        'runtimeArtifactId',
        'name',
        'classification',
        'visibility',
        'expectedVersion',
        'idempotencyKey'
      ],
      properties: {
        projectId: uuid,
        workItemId: { anyOf: [uuid, { type: 'null' }] },
        runtimeArtifactId: uuid,
        name: { type: 'string', minLength: 1, maxLength: 255 },
        classification,
        visibility,
        expectedVersion: resourceVersion,
        idempotencyKey
      }
    },
    inputZod: ArtifactRegisterInputSchema,
    sideEffect: true,
    requiredPermissions: ['mcp.artifact.write', 'artifact.publish'],
    requiresIdempotencyKey: true,
    requiresExpectedVersion: true,
    maxOutputBytes: 131072
  },
  {
    name: 'pie.execution_context.get',
    description:
      'Report the local session binding (project/work-item/workspace/agent-session/host).',
    inputSchema: { type: 'object', additionalProperties: false },
    inputZod: ExecutionContextGetInputSchema,
    sideEffect: false,
    requiredPermissions: ['mcp.execution_context.read'],
    requiresIdempotencyKey: false,
    requiresExpectedVersion: false,
    maxOutputBytes: 65536
  }
]

export function findTool(name: string): PieMcpToolDescriptor | undefined {
  return PIE_MCP_TOOLS.find((tool) => tool.name === name)
}
