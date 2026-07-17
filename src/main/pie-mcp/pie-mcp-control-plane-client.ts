import {
  ProjectsListOutputSchema,
  WorkItemGetOutputSchema,
  WorkItemsSearchOutputSchema,
  WorkItemCommentCreateOutputSchema,
  ExecutionContextGetOutputSchema,
  type ProjectsListOutput,
  type WorkItemGetOutput,
  type WorkItemsSearchOutput,
  type WorkItemCommentCreateInput,
  type WorkItemCommentCreateOutput,
  type ArtifactRegisterInput,
  type ArtifactRegisterOutput,
  type ExecutionContextGetOutput
} from './pie-mcp-tool-io-schemas'
import type { AuthorizedContext } from './pie-mcp-session-authority'

export class PieMcpControlPlaneError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'PieMcpControlPlaneError'
    this.status = status
  }
}

export type ProjectsListParams = {
  query?: string
  cursor?: string
  limit?: number
}

export type WorkItemsSearchParams = {
  query: string
  projectId?: string
  cursor?: string
  limit?: number
}

// Each method maps one MCP tool to its control-plane operation. The bearer token
// lives in the injected AuthorizedContext (never a tool argument, never logged).
export type PieMcpControlPlaneClient = {
  listProjects(context: AuthorizedContext, params: ProjectsListParams): Promise<ProjectsListOutput>
  getWorkItem(context: AuthorizedContext, workItemId: string): Promise<WorkItemGetOutput>
  searchWorkItems(
    context: AuthorizedContext,
    params: WorkItemsSearchParams
  ): Promise<WorkItemsSearchOutput>
  createWorkItemComment(
    context: AuthorizedContext,
    input: WorkItemCommentCreateInput
  ): Promise<WorkItemCommentCreateOutput>
  registerArtifact(
    context: AuthorizedContext,
    input: ArtifactRegisterInput
  ): Promise<ArtifactRegisterOutput>
  getExecutionContext(context: AuthorizedContext): Promise<ExecutionContextGetOutput>
}

function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
}

function jsonHeaders(accessToken: string): Record<string, string> {
  return { ...authHeaders(accessToken), 'content-type': 'application/json' }
}

function orgBase(context: AuthorizedContext): string {
  return `${context.apiBaseUrl}/organizations/${context.organizationId}`
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    throw new PieMcpControlPlaneError(
      `${operation} failed with ${response.status}`,
      response.status
    )
  }
  return response.json()
}

/** Fetch-backed client. Live endpoints: projects.list, work_items.get,
 *  work_items.comment.create. searchWorkItems degrades to the list endpoint until
 *  a real search route exists. registerArtifact and getExecutionContext are
 *  deferred seams (see below). Tests inject a fake in place of this. */
export function createFetchPieMcpControlPlaneClient(
  fetchImpl: typeof fetch = fetch
): PieMcpControlPlaneClient {
  return {
    async listProjects(context, params) {
      const query = new URLSearchParams()
      if (params.cursor !== undefined) {
        query.set('cursor', params.cursor)
      }
      if (params.limit !== undefined) {
        query.set('limit', String(params.limit))
      }
      // TODO(pie-r5-s5b-live): listProjects has no server-side `query` filter yet;
      // the query hint is ignored until the control-plane adds full-text search.
      const suffix = query.toString() ? `?${query.toString()}` : ''
      const response = await fetchImpl(`${orgBase(context)}/projects${suffix}`, {
        headers: authHeaders(context.accessToken)
      })
      return ProjectsListOutputSchema.parse(await readJson(response, 'list projects'))
    },

    async getWorkItem(context, workItemId) {
      const response = await fetchImpl(`${orgBase(context)}/work-items/${workItemId}`, {
        headers: authHeaders(context.accessToken)
      })
      return WorkItemGetOutputSchema.parse({ workItem: await readJson(response, 'get work item') })
    },

    async searchWorkItems(context, params) {
      // TODO(pie-r5-s5b-live): no work-items full-text search endpoint exists yet.
      // Degrade to the list endpoint (available data); server-side query filtering
      // lands with the live search route.
      const query = new URLSearchParams()
      if (params.projectId !== undefined) {
        query.set('projectId', params.projectId)
      }
      if (params.cursor !== undefined) {
        query.set('cursor', params.cursor)
      }
      if (params.limit !== undefined) {
        query.set('limit', String(params.limit))
      }
      const suffix = query.toString() ? `?${query.toString()}` : ''
      const response = await fetchImpl(`${orgBase(context)}/work-items${suffix}`, {
        headers: authHeaders(context.accessToken)
      })
      return WorkItemsSearchOutputSchema.parse(await readJson(response, 'search work items'))
    },

    async createWorkItemComment(context, input) {
      const response = await fetchImpl(
        `${orgBase(context)}/work-items/${input.workItemId}/comments`,
        {
          method: 'POST',
          // Idempotency-Key makes a retried create safe; If-Match carries the
          // expected work-item version so a stale write is rejected, not clobbered.
          headers: {
            ...jsonHeaders(context.accessToken),
            'idempotency-key': input.idempotencyKey,
            'if-match': `"work-item-${input.expectedVersion}"`
          },
          body: JSON.stringify({ body: input.body, visibility: input.visibility })
        }
      )
      const comment = await readJson(response, 'create comment')
      return WorkItemCommentCreateOutputSchema.parse({
        comment,
        workItemVersion: input.expectedVersion,
        correlationId: input.projectId
      })
    },

    async registerArtifact(_context, _input) {
      // TODO(pie-r5-s5b-live): no direct artifact-register endpoint; the live wiring
      // maps to the upload-intent/finalize flow. Do not fabricate metadata here.
      throw new PieMcpControlPlaneError('artifact register endpoint not yet available')
    },

    async getExecutionContext(_context) {
      // TODO(pie-r5-s2b): the signed ExecutionContext is not built yet. Report an
      // honest unbound context rather than fabricating a signed binding.
      return ExecutionContextGetOutputSchema.parse({
        bound: false,
        projectId: null,
        workItemId: null,
        workspaceId: null,
        agentSessionId: null,
        host: {
          hostId: '00000000-0000-4000-8000-000000000000',
          type: 'native',
          platform:
            process.platform === 'win32'
              ? 'win32'
              : process.platform === 'darwin'
                ? 'darwin'
                : 'linux',
          pathStyle: process.platform === 'win32' ? 'windows' : 'posix',
          caseSensitivePaths: process.platform !== 'win32' && process.platform !== 'darwin'
        }
      })
    }
  }
}
