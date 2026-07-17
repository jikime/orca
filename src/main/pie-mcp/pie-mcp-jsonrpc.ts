// Minimal JSON-RPC 2.0 for the MCP stdio transport. Framing is newline-delimited:
// each message is one JSON object on its own line with no embedded newlines
// (MCP stdio 2025-11-25). OS-neutral — no Content-Length, no shell assumptions.

export const JSON_RPC_VERSION = '2.0'

export const JSON_RPC_PARSE_ERROR = -32700
export const JSON_RPC_INVALID_REQUEST = -32600
export const JSON_RPC_METHOD_NOT_FOUND = -32601
export const JSON_RPC_INVALID_PARAMS = -32602
export const JSON_RPC_INTERNAL_ERROR = -32603

export type JsonRpcId = string | number | null

export type JsonRpcRequest = {
  jsonrpc: string
  id?: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcSuccess = {
  jsonrpc: typeof JSON_RPC_VERSION
  id: JsonRpcId
  result: unknown
}

export type JsonRpcErrorBody = {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcError = {
  jsonrpc: typeof JSON_RPC_VERSION
  id: JsonRpcId
  error: JsonRpcErrorBody
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSON_RPC_VERSION, id, result }
}

export function failure(id: JsonRpcId, code: number, message: string): JsonRpcError {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } }
}

/** Serialize one message to a single newline-terminated frame. */
export function serializeFrame(message: JsonRpcResponse): string {
  return `${JSON.stringify(message)}\n`
}

/** Splits a growing buffer into complete lines; returns the leftover partial line
 *  so a chunk split mid-message is reassembled on the next read. */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  const frames = parts.map((line) => line.trim()).filter((line) => line.length > 0)
  return { frames, rest }
}

export type ParsedFrame =
  | { ok: true; request: JsonRpcRequest }
  | { ok: false; id: JsonRpcId; code: number; message: string }

export function parseFrame(frame: string): ParsedFrame {
  let value: unknown
  try {
    value = JSON.parse(frame)
  } catch {
    return { ok: false, id: null, code: JSON_RPC_PARSE_ERROR, message: 'parse error' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, id: null, code: JSON_RPC_INVALID_REQUEST, message: 'invalid request' }
  }
  const record = value as Record<string, unknown>
  const id = (record.id ?? null) as JsonRpcId
  if (record.jsonrpc !== JSON_RPC_VERSION || typeof record.method !== 'string') {
    return { ok: false, id, code: JSON_RPC_INVALID_REQUEST, message: 'invalid request' }
  }
  return { ok: true, request: record as unknown as JsonRpcRequest }
}
