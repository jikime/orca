import {
  assignAsset,
  createAsset,
  createAssetLink,
  deleteAssetLink,
  getAsset,
  listAssetEventsByAsset,
  listAssetLinksByAsset,
  listAssets,
  transitionAssetStatus,
  updateAsset,
  type AssetLinkResource,
  type AssetResource,
  type AssetStatus,
  type AssetStatusAction,
  type AssetType,
  type LinkedKind,
  type LinkRelation,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const SCHEMA = {
  asset: 'https://schemas.pielab.ai/resources/asset.v1.schema.json',
  assetCreate: 'https://schemas.pielab.ai/resources/asset-create.v1.schema.json',
  assetUpdate: 'https://schemas.pielab.ai/resources/asset-update.v1.schema.json',
  assetTransition: 'https://schemas.pielab.ai/resources/asset-transition.v1.schema.json',
  assetAssign: 'https://schemas.pielab.ai/resources/asset-assign.v1.schema.json',
  assetLink: 'https://schemas.pielab.ai/resources/asset-link.v1.schema.json',
  assetLinkCreate: 'https://schemas.pielab.ai/resources/asset-link-create.v1.schema.json',
  assetEvent: 'https://schemas.pielab.ai/resources/asset-event.v1.schema.json'
} as const

const ASSET_READ = 'asset.read'
const ASSET_MANAGE = 'asset.manage'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ASSET_STATUSES: readonly AssetStatus[] = ['active', 'in_repair', 'retired', 'lost']

export type AssetRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

function problem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  title: string
): FastifyReply {
  sendProblem(
    reply,
    buildProblemDetails({
      status,
      title,
      code,
      requestId: requestCorrelationId(request),
      instance: request.url
    })
  )
  return reply
}

function validates(registry: ContractSchemaRegistry, schemaId: string, body: unknown): boolean {
  const validate = registry.ajv.getSchema(schemaId)
  return !validate || validate(body) === true
}

function assertResponse(registry: ContractSchemaRegistry, schemaId: string, body: unknown): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${schemaId}`)
  }
}

function etag(prefix: string, version: number): string {
  return `"${prefix}-${version}"`
}

function ifMatchVersion(request: FastifyRequest, prefix: string): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? new RegExp(`^"${prefix}-(\\d+)"$`).exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

// Splits `<id>:<action>` (custom method), mirroring governance / qa action routes.
function parseTarget(target: string): { id: string; action: string } {
  const colon = target.lastIndexOf(':')
  return {
    id: colon === -1 ? target : target.slice(0, colon),
    action: colon === -1 ? '' : target.slice(colon + 1)
  }
}

async function guard(
  deps: AssetRoutesDeps,
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  permission: string
): Promise<{ userId: string } | null> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return null
  if (!UUID_PATTERN.test(organizationId)) {
    problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    return null
  }
  const authz = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    permission
  )
  if (!authz) return null
  return { userId: authz.userId ?? organizationId }
}

export function registerAssetRoutes(app: FastifyInstance, deps: AssetRoutesDeps): void {
  registerAssetCrudRoutes(app, deps)
  registerAssetLinkRoutes(app, deps)
  registerAssetEventRoutes(app, deps)
}

// === assets: create / list / get / update(OCC) / :transition / :assign ===
function registerAssetCrudRoutes(app: FastifyInstance, deps: AssetRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/assets', (request, reply) =>
    createAssetHandler(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/assets', async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }
    const auth = await guard(deps, app, request, reply, organizationId, ASSET_READ)
    if (!auth) return reply
    const query = request.query as {
      accountId?: string
      projectId?: string
      status?: string
      assignedToUserId?: string
      cursor?: string
    }
    if (query.status !== undefined && !ASSET_STATUSES.includes(query.status as AssetStatus))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid status filter')
    const page = await listAssets(deps.db, organizationId, {
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status ? { status: query.status as AssetStatus } : {}),
      ...(query.assignedToUserId ? { assignedToUserId: query.assignedToUserId } : {}),
      cursor: query.cursor ?? null
    })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.asset, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
  app.get('/v1/organizations/:organizationId/assets/:assetId', async (request, reply) => {
    const { organizationId, assetId } = request.params as {
      organizationId: string
      assetId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, ASSET_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(assetId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const asset = await getAsset(deps.db, organizationId, assetId)
    if (!asset) return problem(reply, request, 404, 'NOT_FOUND', 'asset not found')
    assertResponse(deps.registry, SCHEMA.asset, asset)
    void reply.header('etag', etag('asset', asset.version))
    return asset
  })
  app.patch('/v1/organizations/:organizationId/assets/:assetId', (request, reply) =>
    updateAssetHandler(app, deps, request, reply)
  )
  app.post('/v1/organizations/:organizationId/assets/:assetTarget', (request, reply) =>
    assetActionHandler(app, deps, request, reply)
  )
}

async function createAssetHandler(
  app: FastifyInstance,
  deps: AssetRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId } = request.params as { organizationId: string }
  const auth = await guard(deps, app, request, reply, organizationId, ASSET_MANAGE)
  if (!auth) return reply
  if (!validates(deps.registry, SCHEMA.assetCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid asset create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/assets'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (asset: AssetResource): AssetResource => {
    assertResponse(deps.registry, SCHEMA.asset, asset)
    void reply
      .code(201)
      .header('etag', etag('asset', asset.version))
      .header('location', `/v1/organizations/${organizationId}/assets/${asset.id}`)
    return asset
  }
  if (gate.priorResourceId) {
    const existing = await getAsset(deps.db, organizationId, gate.priorResourceId)
    if (existing) return respond(existing)
  }
  const body = request.body as {
    name: string
    assetType?: AssetType
    accountId?: string
    projectId?: string
    assignedToUserId?: string
    identifier?: string
    vendor?: string
    purchaseDate?: string
    warrantyEnd?: string
    notes?: string
  }
  const created = await createAsset(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    name: body.name,
    assetType: body.assetType,
    accountId: body.accountId ?? null,
    projectId: body.projectId ?? null,
    assignedToUserId: body.assignedToUserId ?? null,
    identifier: body.identifier ?? null,
    vendor: body.vendor ?? null,
    purchaseDate: body.purchaseDate ?? null,
    warrantyEnd: body.warrantyEnd ?? null,
    notes: body.notes ?? null
  })
  await gate.complete(created.id)
  return respond(created)
}

async function updateAssetHandler(
  app: FastifyInstance,
  deps: AssetRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, assetId } = request.params as {
    organizationId: string
    assetId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, ASSET_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(assetId)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.assetUpdate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid asset update')
  const expectedVersion = ifMatchVersion(request, 'asset')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  const body = (request.body ?? {}) as {
    name?: string
    assetType?: AssetType
    accountId?: string | null
    projectId?: string | null
    identifier?: string | null
    vendor?: string | null
    purchaseDate?: string | null
    warrantyEnd?: string | null
    notes?: string | null
  }
  const result = await updateAsset(deps.db, {
    organizationId,
    assetId,
    actorUserId: auth.userId,
    expectedVersion,
    ...body
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'asset not found')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'asset modified concurrently')
  }
  assertResponse(deps.registry, SCHEMA.asset, result.asset)
  void reply.header('etag', etag('asset', result.asset.version))
  return result.asset
}

function isAssetStatusAction(action: string): action is AssetStatusAction {
  return (
    action === 'repair' || action === 'restore' || action === 'retire' || action === 'report_lost'
  )
}

// Custom methods on an asset: `<id>:transition` (OCC status walk) and `<id>:assign` (OCC assignment).
async function assetActionHandler(
  app: FastifyInstance,
  deps: AssetRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, assetTarget } = request.params as {
    organizationId: string
    assetTarget: string
  }
  const { id, action } = parseTarget(assetTarget)
  if (action !== 'transition' && action !== 'assign')
    return problem(reply, request, 404, 'NOT_FOUND', 'unknown asset action')
  const auth = await guard(deps, app, request, reply, organizationId, ASSET_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(id)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  const expectedVersion = ifMatchVersion(request, 'asset')
  if (expectedVersion === null)
    return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
  if (action === 'transition')
    return transitionAssetHandler(
      deps,
      request,
      reply,
      organizationId,
      id,
      auth.userId,
      expectedVersion
    )
  return assignAssetHandler(deps, request, reply, organizationId, id, auth.userId, expectedVersion)
}

async function transitionAssetHandler(
  deps: AssetRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  assetId: string,
  actorUserId: string,
  expectedVersion: number
): Promise<unknown> {
  if (!validates(deps.registry, SCHEMA.assetTransition, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid transition')
  const move = (request.body as { action?: string }).action ?? ''
  if (!isAssetStatusAction(move))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid asset action')
  const result = await transitionAssetStatus(deps.db, {
    organizationId,
    assetId,
    actorUserId,
    action: move,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'asset not found')
    if (result.reason === 'version_conflict')
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'asset modified concurrently')
    return problem(
      reply,
      request,
      409,
      'ILLEGAL_TRANSITION',
      `cannot ${move} an asset in ${result.from}`
    )
  }
  assertResponse(deps.registry, SCHEMA.asset, result.asset)
  void reply.header('etag', etag('asset', result.asset.version))
  return result.asset
}

async function assignAssetHandler(
  deps: AssetRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  assetId: string,
  actorUserId: string,
  expectedVersion: number
): Promise<unknown> {
  if (!validates(deps.registry, SCHEMA.assetAssign, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid assign request')
  const assignedToUserId = (request.body as { assignedToUserId?: string | null }).assignedToUserId
  if (assignedToUserId !== null && !UUID_PATTERN.test(assignedToUserId ?? ''))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid assignedToUserId')
  const result = await assignAsset(deps.db, {
    organizationId,
    assetId,
    actorUserId,
    assignedToUserId: assignedToUserId ?? null,
    expectedVersion
  })
  if (!result.ok) {
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'asset not found')
    return problem(reply, request, 409, 'VERSION_CONFLICT', 'asset modified concurrently')
  }
  assertResponse(deps.registry, SCHEMA.asset, result.asset)
  void reply.header('etag', etag('asset', result.asset.version))
  return result.asset
}

// === CMDB links: create / list-by-asset / delete ===
function registerAssetLinkRoutes(app: FastifyInstance, deps: AssetRoutesDeps): void {
  app.post('/v1/organizations/:organizationId/assets/:assetId/links', (request, reply) =>
    createLinkHandler(app, deps, request, reply)
  )
  app.get('/v1/organizations/:organizationId/assets/:assetId/links', async (request, reply) => {
    const { organizationId, assetId } = request.params as {
      organizationId: string
      assetId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, ASSET_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(assetId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const { cursor } = request.query as { cursor?: string }
    const page = await listAssetLinksByAsset(deps.db, organizationId, assetId, {
      cursor: cursor ?? null
    })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.assetLink, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
  app.delete(
    '/v1/organizations/:organizationId/assets/:assetId/links/:linkId',
    async (request, reply) => {
      const { organizationId, linkId } = request.params as {
        organizationId: string
        linkId: string
      }
      const auth = await guard(deps, app, request, reply, organizationId, ASSET_MANAGE)
      if (!auth) return reply
      if (!UUID_PATTERN.test(linkId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const result = await deleteAssetLink(deps.db, {
        organizationId,
        actorUserId: auth.userId,
        linkId
      })
      if (!result.ok) return problem(reply, request, 404, 'NOT_FOUND', 'link not found')
      void reply.code(204)
      return reply
    }
  )
}

async function createLinkHandler(
  app: FastifyInstance,
  deps: AssetRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { organizationId, assetId } = request.params as {
    organizationId: string
    assetId: string
  }
  const auth = await guard(deps, app, request, reply, organizationId, ASSET_MANAGE)
  if (!auth) return reply
  if (!UUID_PATTERN.test(assetId)) return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
  if (!validates(deps.registry, SCHEMA.assetLinkCreate, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid link create')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    {
      organizationId,
      principalId: auth.userId,
      method: 'POST',
      route: '/v1/organizations/{organizationId}/assets/{assetId}/links'
    },
    request.body
  )
  if (!gate) return reply
  const respond = (link: AssetLinkResource): AssetLinkResource => {
    assertResponse(deps.registry, SCHEMA.assetLink, link)
    void reply
      .code(201)
      .header('etag', etag('asset-link', link.version))
      .header('location', `/v1/organizations/${organizationId}/assets/${assetId}/links/${link.id}`)
    return link
  }
  const body = request.body as {
    linkedKind: LinkedKind
    linkedId: string
    relation?: LinkRelation
  }
  const result = await createAssetLink(deps.db, {
    organizationId,
    actorUserId: auth.userId,
    assetId,
    linkedKind: body.linkedKind,
    linkedId: body.linkedId,
    relation: body.relation
  })
  if (!result.ok) return problem(reply, request, 409, 'DUPLICATE_LINK', 'link already exists')
  await gate.complete(result.link.id)
  return respond(result.link)
}

// === lifecycle event log: list-by-asset (append-only, read-only over the wire) ===
function registerAssetEventRoutes(app: FastifyInstance, deps: AssetRoutesDeps): void {
  app.get('/v1/organizations/:organizationId/assets/:assetId/events', async (request, reply) => {
    const { organizationId, assetId } = request.params as {
      organizationId: string
      assetId: string
    }
    const auth = await guard(deps, app, request, reply, organizationId, ASSET_READ)
    if (!auth) return reply
    if (!UUID_PATTERN.test(assetId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const { cursor } = request.query as { cursor?: string }
    const page = await listAssetEventsByAsset(deps.db, organizationId, assetId, {
      cursor: cursor ?? null
    })
    for (const item of page.items) assertResponse(deps.registry, SCHEMA.assetEvent, item)
    return { items: page.items, nextCursor: page.nextCursor }
  })
}
