import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { PieSessionState } from '../../shared/pie-session-contract'
import type { PieMcpControlPlaneClient } from './pie-mcp-control-plane-client'
import { serializeFrame } from './pie-mcp-jsonrpc'
import type { PieMcpAuthority } from './pie-mcp-session-authority'
import { createPieMcpServer } from './pie-mcp-server-core'
import { PIE_MCP_PROTOCOL_VERSION } from './pie-mcp-tool-registry'

const repoRoot = path.resolve(import.meta.dirname, '../../..')

function fixture(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'contracts/fixtures', relative), 'utf8'))
}

const ORG = '20000000-0000-4000-8000-000000000001'
const PROJECT = '10000000-0000-4000-8000-000000000002'
const WORK_ITEM = '10000000-0000-4000-8000-000000000003'
const AUTHOR = '20000000-0000-4000-8000-000000000004'

function projectFixture(): unknown {
  return {
    id: PROJECT,
    organizationId: ORG,
    name: 'Portal',
    status: 'active',
    version: 1,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z'
  }
}

function workItemFixture(): unknown {
  return {
    id: WORK_ITEM,
    organizationId: ORG,
    teamId: '20000000-0000-4000-8000-000000000005',
    projectId: PROJECT,
    identifier: 'POR-12',
    title: 'Ship MCP server',
    stateId: '20000000-0000-4000-8000-000000000006',
    priority: 'high',
    version: 2,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z'
  }
}

function commentFixture(): unknown {
  return {
    id: '20000000-0000-4000-8000-000000000007',
    organizationId: ORG,
    workItemId: WORK_ITEM,
    authorId: AUTHOR,
    body: 'Contract validation completed.',
    visibility: 'internal',
    createdAt: '2026-07-16T00:00:00.000Z'
  }
}

function artifactFixture(): unknown {
  return {
    id: '20000000-0000-4000-8000-000000000008',
    organizationId: ORG,
    projectId: PROJECT,
    workItemId: WORK_ITEM,
    name: 'report.pdf',
    classification: 'internal',
    visibility: 'project',
    status: 'available',
    revision: 1,
    version: 1,
    createdAt: '2026-07-16T00:00:00.000Z'
  }
}

type FakeClientOverrides = {
  executionContext?: unknown
}

function fakeClient(overrides: FakeClientOverrides = {}): PieMcpControlPlaneClient {
  return {
    listProjects: async () => ({ items: [projectFixture()] as never, nextCursor: null }),
    getWorkItem: async () => ({ workItem: workItemFixture() as never }),
    searchWorkItems: async () => ({ items: [workItemFixture()] as never, nextCursor: null }),
    createWorkItemComment: async () => ({
      comment: commentFixture() as never,
      workItemVersion: 2,
      correlationId: PROJECT
    }),
    registerArtifact: async () => ({
      artifact: artifactFixture() as never,
      correlationId: PROJECT
    }),
    getExecutionContext: async () =>
      (overrides.executionContext ?? fixture('valid/mcp-execution-context-output.json')) as never
  }
}

const ALL_PERMISSIONS = [
  'mcp.project.read',
  'mcp.work_item.read',
  'mcp.work_item.write',
  'work_item.comment',
  'mcp.artifact.write',
  'artifact.publish',
  'mcp.execution_context.read'
]

function signedInSession(permissions: string[] = ALL_PERMISSIONS): PieSessionState {
  return {
    status: 'signed_in',
    instanceId: 'local-desktop',
    userId: AUTHOR,
    displayName: 'Local User',
    organizationId: ORG,
    permissions,
    expiresAt: '2026-07-17T00:00:00.000Z'
  } as PieSessionState
}

function authority(session: PieSessionState = signedInSession()): PieMcpAuthority {
  return {
    getSession: () => session,
    getAccessToken: () => 'secret-access-token',
    getApiBaseUrl: () => 'https://cp.example/v1'
  }
}

function makeServer(
  overrides: { session?: PieSessionState; client?: PieMcpControlPlaneClient } = {}
) {
  return createPieMcpServer({
    authority: authority(overrides.session),
    client: overrides.client ?? fakeClient()
  })
}

function callFrame(id: number, name: string, args: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  })
}

describe('pie-mcp server core', () => {
  it('answers the initialize handshake with the frozen protocol version', async () => {
    const response = await makeServer().handleFrame(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    )
    expect(response).toMatchObject({
      id: 1,
      result: {
        protocolVersion: PIE_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'pie-local' }
      }
    })
  })

  it('lists all six tools with schemas on tools/list', async () => {
    const response = (await makeServer().handleFrame(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    )) as { result: { tools: { name: string; inputSchema: unknown }[] } }
    const names = response.result.tools.map((tool) => tool.name)
    expect(names).toEqual([
      'pie.projects.list',
      'pie.work_items.get',
      'pie.work_items.search',
      'pie.work_items.comment.create',
      'pie.artifacts.register',
      'pie.execution_context.get'
    ])
    for (const tool of response.result.tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' })
    }
  })

  it('accepts the projects.list valid fixture and returns schema-shaped output', async () => {
    const response = (await makeServer().handleFrame(
      callFrame(3, 'pie.projects.list', fixture('valid/mcp-projects-list-input.json'))
    )) as {
      result: { isError: boolean; structuredContent: { items: unknown[]; nextCursor: unknown } }
    }
    expect(response.result.isError).toBe(false)
    expect(response.result.structuredContent.items).toHaveLength(1)
    expect(response.result.structuredContent.nextCursor).toBeNull()
  })

  it('accepts the comment.create valid fixture (write with idempotency + expected version)', async () => {
    const response = (await makeServer().handleFrame(
      callFrame(
        4,
        'pie.work_items.comment.create',
        fixture('valid/mcp-work-item-comment-create-input.json')
      )
    )) as { result: { isError: boolean; structuredContent: { workItemVersion: number } } }
    expect(response.result.isError).toBe(false)
    expect(response.result.structuredContent.workItemVersion).toBe(2)
  })

  it('produces the execution-context output shape', async () => {
    const response = (await makeServer().handleFrame(
      callFrame(5, 'pie.execution_context.get', {})
    )) as {
      result: { isError: boolean; structuredContent: { bound: boolean } }
    }
    expect(response.result.isError).toBe(false)
    expect(response.result.structuredContent.bound).toBe(true)
  })

  it('REJECTS the token-passthrough invalid fixture (no credential in tool input)', async () => {
    const response = (await makeServer().handleFrame(
      callFrame(6, 'pie.projects.list', fixture('invalid/mcp-projects-list-token-passthrough.json'))
    )) as { result: { isError: boolean; structuredContent: { error: { code: string } } } }
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent.error.code).toBe('credential_in_input')
  })

  it('REJECTS the missing-idempotency write fixture', async () => {
    const response = (await makeServer().handleFrame(
      callFrame(
        7,
        'pie.work_items.comment.create',
        fixture('invalid/mcp-comment-missing-idempotency.json')
      )
    )) as { result: { isError: boolean; structuredContent: { error: { code: string } } } }
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent.error.code).toBe('missing_idempotency_key')
  })

  it('rejects a write missing expectedVersion', async () => {
    const args = fixture('valid/mcp-work-item-comment-create-input.json') as Record<string, unknown>
    delete args.expectedVersion
    const response = (await makeServer().handleFrame(
      callFrame(8, 'pie.work_items.comment.create', args)
    )) as { result: { isError: boolean; structuredContent: { error: { code: string } } } }
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent.error.code).toBe('missing_expected_version')
  })

  it('returns a clean MCP error when a required permission is missing (no crash)', async () => {
    const server = makeServer({ session: signedInSession(['mcp.work_item.read']) })
    const response = (await server.handleFrame(
      callFrame(9, 'pie.projects.list', { limit: 5 })
    )) as {
      result: { isError: boolean; structuredContent: { error: { code: string; message: string } } }
    }
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent.error.code).toBe('permission_denied')
    expect(response.result.structuredContent.error.message).toContain('mcp.project.read')
  })

  it('returns unauthorized (clean error) when the session is signed out', async () => {
    const server = createPieMcpServer({
      authority: {
        getSession: () =>
          ({ status: 'signed_out', instanceId: 'local-desktop' }) as PieSessionState,
        getAccessToken: () => null,
        getApiBaseUrl: () => null
      },
      client: fakeClient()
    })
    const response = (await server.handleFrame(callFrame(10, 'pie.projects.list', {}))) as {
      result: { isError: boolean; structuredContent: { error: { code: string } } }
    }
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent.error.code).toBe('unauthorized')
  })

  it('bounds output that exceeds maxOutputBytes (never emits the raw oversized payload)', async () => {
    const oversized = {
      bound: true,
      projectId: null,
      workItemId: null,
      workspaceId: null,
      agentSessionId: null,
      host: {
        hostId: '30000000-0000-4000-8000-000000000004',
        type: 'native',
        platform: 'linux',
        pathStyle: 'posix',
        caseSensitivePaths: true
      },
      padding: 'x'.repeat(70000)
    }
    const server = makeServer({ client: fakeClient({ executionContext: oversized }) })
    const response = (await server.handleFrame(callFrame(11, 'pie.execution_context.get', {}))) as {
      result: {
        isError: boolean
        content: { text: string }[]
        structuredContent: { error: { code: string } }
      }
    }
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent.error.code).toBe('output_too_large')
    const frame = serializeFrame(response as never)
    expect(frame).not.toContain('x'.repeat(70000))
    expect(Buffer.byteLength(frame)).toBeLessThan(70000)
  })

  it('tolerates an unknown optional field in the execution-context output (forward-compat)', async () => {
    const compat = fixture('compatibility/mcp-execution-context-unknown-optional.json')
    const server = makeServer({ client: fakeClient({ executionContext: compat }) })
    const response = (await server.handleFrame(callFrame(12, 'pie.execution_context.get', {}))) as {
      result: { isError: boolean; structuredContent: Record<string, unknown> }
    }
    expect(response.result.isError).toBe(false)
    expect(response.result.structuredContent.futureBindingHint).toBe('ignored')
  })

  it('returns a JSON-RPC parse error on a malformed frame without crashing', async () => {
    const server = makeServer()
    const bad = (await server.handleFrame('{ not json')) as { error: { code: number } }
    expect(bad.error.code).toBe(-32700)
    // The server still serves the next valid frame.
    const ok = (await server.handleFrame(
      JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/list' })
    )) as { result: { tools: unknown[] } }
    expect(ok.result.tools).toHaveLength(6)
  })

  it('returns method-not-found for an unknown method', async () => {
    const response = (await makeServer().handleFrame(
      JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'resources/list' })
    )) as { error: { code: number } }
    expect(response.error.code).toBe(-32601)
  })

  it('never places the access token in a response frame', async () => {
    const response = await makeServer().handleFrame(
      callFrame(15, 'pie.projects.list', { limit: 3 })
    )
    expect(serializeFrame(response as never)).not.toContain('secret-access-token')
  })

  it('REJECTS a read whose args name a different organization (confused-deputy, no delegation)', async () => {
    let calls = 0
    const base = fakeClient()
    const spy: PieMcpControlPlaneClient = {
      ...base,
      listProjects: async (context, params) => {
        calls += 1
        return base.listProjects(context, params)
      }
    }
    const server = makeServer({ client: spy })
    const response = (await server.handleFrame(
      callFrame(16, 'pie.projects.list', {
        organizationId: '20000000-0000-4000-8000-0000000000ff',
        limit: 3
      })
    )) as { result: { isError: boolean; structuredContent: { error: { code: string } } } }
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent.error.code).toBe('org_scope_violation')
    // Confinement rejects before delegation: the control-plane is never reached.
    expect(calls).toBe(0)
  })

  it('REJECTS a write that smuggles a foreign tenant id before any delegation', async () => {
    let calls = 0
    const base = fakeClient()
    const spy: PieMcpControlPlaneClient = {
      ...base,
      createWorkItemComment: async (context, input) => {
        calls += 1
        return base.createWorkItemComment(context, input)
      }
    }
    const server = makeServer({ client: spy })
    const args = {
      ...(fixture('valid/mcp-work-item-comment-create-input.json') as Record<string, unknown>),
      tenantId: '20000000-0000-4000-8000-0000000000ff'
    }
    const response = (await server.handleFrame(
      callFrame(17, 'pie.work_items.comment.create', args)
    )) as { result: { isError: boolean; structuredContent: { error: { code: string } } } }
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent.error.code).toBe('org_scope_violation')
    expect(calls).toBe(0)
  })

  it('confines the downstream call to the session org (built from the session, not args)', async () => {
    let seenOrg: string | null = null
    const base = fakeClient()
    const spy: PieMcpControlPlaneClient = {
      ...base,
      listProjects: async (context, params) => {
        seenOrg = context.organizationId
        return base.listProjects(context, params)
      }
    }
    const server = makeServer({ client: spy })
    const response = (await server.handleFrame(
      callFrame(18, 'pie.projects.list', { limit: 3 })
    )) as { result: { isError: boolean } }
    expect(response.result.isError).toBe(false)
    expect(seenOrg).toBe(ORG)
  })

  it('allows an arg that names the session org past confinement (no org_scope_violation)', async () => {
    // A matching org id is not a confinement violation; it fails later on the tool's
    // strict schema (no tool declares an org field), never as org_scope_violation.
    const response = (await makeServer().handleFrame(
      callFrame(19, 'pie.projects.list', { organizationId: ORG, limit: 3 })
    )) as { result: { isError: boolean; structuredContent: { error: { code: string } } } }
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent.error.code).toBe('invalid_input')
  })
})
