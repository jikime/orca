import type { Readable, Writable } from 'node:stream'

import type { PieSessionState } from '../../shared/pie-session-contract'
import { createFetchPieMcpControlPlaneClient } from './pie-mcp-control-plane-client'
import { serializeFrame, splitFrames } from './pie-mcp-jsonrpc'
import { createRegistryAuthority } from './pie-mcp-session-authority'
import { createPieMcpServer, type PieMcpServerDeps } from './pie-mcp-server-core'

export type PieMcpStdioOptions = {
  input: Readable
  output: Writable
  deps: PieMcpServerDeps
}

/** Pumps a newline-delimited JSON-RPC stream through the server. Frames are
 *  reassembled across chunk boundaries; each response is written as its own line. */
export function runPieMcpStdio(options: PieMcpStdioOptions): void {
  const server = createPieMcpServer(options.deps)
  let buffer = ''

  options.input.setEncoding('utf8')
  options.input.on('data', (chunk: string) => {
    buffer += chunk
    const { frames, rest } = splitFrames(buffer)
    buffer = rest
    for (const frame of frames) {
      void server.handleFrame(frame).then((response) => {
        if (response) {
          options.output.write(serializeFrame(response))
        }
      })
    }
  })
}

/** Thin process entry. Live registration in Claude Code's MCP config and wiring a
 *  real session snapshot are deferred: TODO(pie-r5-s5b-live). This module is not
 *  imported by index.ts startup — it runs standalone as `node …/pie-mcp-server-entry.js`. */
export function startPieMcpServerFromProcess(getSession: () => PieSessionState): void {
  runPieMcpStdio({
    input: process.stdin,
    output: process.stdout,
    deps: {
      authority: createRegistryAuthority(getSession),
      client: createFetchPieMcpControlPlaneClient()
    }
  })
}
