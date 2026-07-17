import type { PieMcpControlPlaneClient } from './pie-mcp-control-plane-client'
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  failure,
  parseFrame,
  success,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './pie-mcp-jsonrpc'
import type { PieMcpAuthority } from './pie-mcp-session-authority'
import { dispatchToolCall, type ToolOutcome } from './pie-mcp-tool-dispatch'
import {
  PIE_MCP_PROTOCOL_VERSION,
  PIE_MCP_SERVER_NAME,
  PIE_MCP_TOOLS,
  findTool,
  type PieMcpToolDescriptor
} from './pie-mcp-tool-registry'

export type PieMcpServerDeps = {
  authority: PieMcpAuthority
  client: PieMcpControlPlaneClient
}

export type PieMcpServer = {
  handleFrame(frame: string): Promise<JsonRpcResponse | null>
}

function toolsListResult(): unknown {
  return {
    tools: PIE_MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }
}

function initializeResult(): unknown {
  return {
    protocolVersion: PIE_MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: PIE_MCP_SERVER_NAME, version: '1.0.0' }
  }
}

function successCallResult(output: unknown): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
    isError: false
  }
}

// Tool-level failures are MCP results with isError:true (so the agent sees a clean
// error) — never a thrown crash. Oversized output is bounded here: the raw payload
// is never emitted, only a bounded-output error.
function errorCallResult(code: string, message: string): unknown {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
    isError: true
  }
}

function boundOutput(tool: PieMcpToolDescriptor, outcome: ToolOutcome): unknown {
  if (!outcome.ok) {
    return errorCallResult(outcome.error.code, outcome.error.message)
  }
  const serialized = JSON.stringify(outcome.output)
  if (Buffer.byteLength(serialized, 'utf8') > tool.maxOutputBytes) {
    return errorCallResult(
      'output_too_large',
      `output exceeds maxOutputBytes (${tool.maxOutputBytes}) for ${tool.name}`
    )
  }
  return successCallResult(outcome.output)
}

async function handleToolsCall(
  request: JsonRpcRequest,
  deps: PieMcpServerDeps
): Promise<JsonRpcResponse> {
  const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown }
  if (typeof params.name !== 'string') {
    return failure(request.id ?? null, JSON_RPC_INVALID_PARAMS, 'tools/call requires a tool name')
  }
  const tool = findTool(params.name)
  if (!tool) {
    return failure(request.id ?? null, JSON_RPC_INVALID_PARAMS, `unknown tool ${params.name}`)
  }
  const outcome = await dispatchToolCall(tool, params.arguments, deps.authority, deps.client)
  return success(request.id ?? null, boundOutput(tool, outcome))
}

export function createPieMcpServer(deps: PieMcpServerDeps): PieMcpServer {
  return {
    async handleFrame(frame) {
      const parsed = parseFrame(frame)
      // A malformed frame yields a JSON-RPC error response, not a crash.
      if (!parsed.ok) {
        return failure(parsed.id, parsed.code, parsed.message)
      }
      const request = parsed.request
      // A notification (no id) gets no response, per JSON-RPC.
      const isNotification = request.id === undefined
      switch (request.method) {
        case 'initialize':
          return isNotification ? null : success(request.id ?? null, initializeResult())
        case 'notifications/initialized':
          return null
        case 'tools/list':
          return isNotification ? null : success(request.id ?? null, toolsListResult())
        case 'tools/call':
          return handleToolsCall(request, deps)
        case 'ping':
          return isNotification ? null : success(request.id ?? null, {})
        default:
          return isNotification
            ? null
            : failure(
                request.id ?? null,
                JSON_RPC_METHOD_NOT_FOUND,
                `unknown method ${request.method}`
              )
      }
    }
  }
}
