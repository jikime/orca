import {
  PieMcpControlPlaneError,
  type PieMcpControlPlaneClient
} from './pie-mcp-control-plane-client'
import {
  missingPermissions,
  resolveAuthority,
  type AuthorizedContext,
  type PieMcpAuthority
} from './pie-mcp-session-authority'
import { findCredentialField } from './pie-mcp-tool-io-schemas'
import type { PieMcpToolDescriptor } from './pie-mcp-tool-registry'

export type ToolErrorCode =
  | 'unauthorized'
  | 'permission_denied'
  | 'invalid_input'
  | 'credential_in_input'
  | 'missing_idempotency_key'
  | 'missing_expected_version'
  | 'output_too_large'
  | 'not_implemented'
  | 'upstream_error'

export type ToolFailure = {
  code: ToolErrorCode
  message: string
}

export type ToolOutcome = { ok: true; output: unknown } | { ok: false; error: ToolFailure }

function fail(code: ToolErrorCode, message: string): ToolOutcome {
  return { ok: false, error: { code, message } }
}

async function callControlPlane(
  tool: PieMcpToolDescriptor,
  input: Record<string, unknown>,
  context: AuthorizedContext,
  client: PieMcpControlPlaneClient
): Promise<unknown> {
  switch (tool.name) {
    case 'pie.projects.list':
      return client.listProjects(context, input)
    case 'pie.work_items.get':
      return client.getWorkItem(context, input.workItemId as string)
    case 'pie.work_items.search':
      return client.searchWorkItems(context, input as never)
    case 'pie.work_items.comment.create':
      return client.createWorkItemComment(context, input as never)
    case 'pie.artifacts.register':
      return client.registerArtifact(context, input as never)
    case 'pie.execution_context.get':
      return client.getExecutionContext(context)
    default:
      throw new PieMcpControlPlaneError(`unknown tool ${tool.name}`)
  }
}

/** Validates, authorizes, and delegates a single tool call. Never throws for an
 *  expected failure (missing permission, bad input, upstream error) — returns a
 *  structured ToolFailure the server surfaces as an isError MCP result. */
export async function dispatchToolCall(
  tool: PieMcpToolDescriptor,
  rawArgs: unknown,
  authority: PieMcpAuthority,
  client: PieMcpControlPlaneClient
): Promise<ToolOutcome> {
  // No-token-passthrough: reject before anything else so a smuggled credential
  // never reaches validation, the client, or a log line.
  const credentialKey = findCredentialField(rawArgs)
  if (credentialKey) {
    return fail(
      'credential_in_input',
      `credential field '${credentialKey}' is not allowed in tool input`
    )
  }

  // Write invariants: a write must be replay-safe (idempotency key) and OCC-guarded
  // (expected version). Checked on raw args before schema validation so the failure
  // code is precise (the mcp-comment-missing-idempotency fixture rejects here).
  const rawObject =
    rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
  if (tool.requiresIdempotencyKey && typeof rawObject.idempotencyKey !== 'string') {
    return fail('missing_idempotency_key', `${tool.name} requires an idempotency key`)
  }
  if (tool.requiresExpectedVersion && typeof rawObject.expectedVersion !== 'number') {
    return fail('missing_expected_version', `${tool.name} requires an expected version`)
  }

  const parsed = tool.inputZod.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    return fail('invalid_input', `input failed schema validation for ${tool.name}`)
  }
  const input = parsed.data as Record<string, unknown>

  const resolution = resolveAuthority(authority)
  if (!resolution.ok) {
    return fail('unauthorized', resolution.reason)
  }
  const absent = missingPermissions(resolution.context.permissions, tool.requiredPermissions)
  if (absent.length > 0) {
    return fail('permission_denied', `missing permission(s): ${absent.join(', ')}`)
  }

  try {
    const output = await callControlPlane(tool, input, resolution.context, client)
    return { ok: true, output }
  } catch (error) {
    if (error instanceof PieMcpControlPlaneError && /not yet available/.test(error.message)) {
      return fail('not_implemented', error.message)
    }
    const message = error instanceof Error ? error.message : 'control-plane call failed'
    return fail('upstream_error', message)
  }
}
