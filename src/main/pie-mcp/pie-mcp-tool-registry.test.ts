import fs from 'node:fs'
import path from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import { PIE_MCP_PROTOCOL_VERSION, PIE_MCP_TOOLS, PIE_MCP_TRANSPORT } from './pie-mcp-tool-registry'

const repoRoot = path.resolve(import.meta.dirname, '../../..')

type ManifestTool = {
  name: string
  sideEffect: boolean
  requiredPermissions: string[]
  requiresIdempotencyKey: boolean
  requiresExpectedVersion: boolean
  maxOutputBytes: number
}

function loadManifest(): { protocolVersion: string; transport: string; tools: ManifestTool[] } {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'contracts/manifests/mcp-tools.json'), 'utf8')
  )
}

describe('pie-mcp tool registry', () => {
  it('mirrors contracts/manifests/mcp-tools.json exactly (no drift)', () => {
    const manifest = loadManifest()
    expect(PIE_MCP_PROTOCOL_VERSION).toBe(manifest.protocolVersion)
    expect(PIE_MCP_TRANSPORT).toBe(manifest.transport)
    expect(PIE_MCP_TOOLS.map((tool) => tool.name)).toEqual(manifest.tools.map((tool) => tool.name))

    for (const manifestTool of manifest.tools) {
      const descriptor = PIE_MCP_TOOLS.find((tool) => tool.name === manifestTool.name)
      expect(descriptor).toBeDefined()
      expect(descriptor?.sideEffect).toBe(manifestTool.sideEffect)
      expect(descriptor?.requiredPermissions).toEqual(manifestTool.requiredPermissions)
      expect(descriptor?.requiresIdempotencyKey).toBe(manifestTool.requiresIdempotencyKey)
      expect(descriptor?.requiresExpectedVersion).toBe(manifestTool.requiresExpectedVersion)
      expect(descriptor?.maxOutputBytes).toBe(manifestTool.maxOutputBytes)
    }
  })

  it('advertises a compilable, self-contained JSON Schema per tool (no remote $ref)', () => {
    const ajv = new Ajv2020({ strict: false })
    for (const tool of PIE_MCP_TOOLS) {
      expect(() => ajv.compile(tool.inputSchema)).not.toThrow()
      expect(JSON.stringify(tool.inputSchema)).not.toContain('$ref')
    }
  })
})
