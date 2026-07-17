import { randomBytes } from 'node:crypto'
import {
  getIssuedCapability,
  issueCapability,
  listSessionCapabilities,
  redeemCapability,
  type CapabilityKind,
  type IssuedCapability,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeResourcePermission } from './route-authorization'

// R8 slice A2: capability-token lifecycle over the control plane (doc 34 §데이터모델 / §보안 제약).
// Issuance + redemption AUTHORITY only — the Relay/host crypto transport is a later phase.
const CAPABILITY_TOKEN_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/capability-token.v1.schema.json'
const CAPABILITY_ISSUE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/capability-issue.v1.schema.json'
const CAPABILITY_REDEEM_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/capability-redeem.v1.schema.json'
const CAPABILITY_GRANT_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/capability-grant.v1.schema.json'
const CAPABILITY_SUMMARY_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/capability-summary.v1.schema.json'
const CAPABILITIES_ROUTE =
  '/v1/organizations/{organizationId}/remote-sessions/{sessionId}/capabilities'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REMOTE_SESSION_RESOURCE_TYPE = 'remote_session'

export type RemoteSessionCapabilityRoutesDeps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
}

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

function toTokenWire(token: IssuedCapability): Record<string, unknown> {
  return {
    id: token.id,
    sessionId: token.sessionId,
    participantId: token.participantId,
    capability: token.capability,
    audience: token.audience,
    nonce: token.nonce,
    expiresAt: token.expiresAt,
    requiresStepUp: token.requiresStepUp
  }
}

// A fresh single-use secret. base64url so it is URL/JSON-safe; 32 bytes of entropy is ample for a
// short-lived opaque nonce (the crypto binding to a channel is a later Relay phase).
function newNonce(): string {
  return randomBytes(32).toString('base64url')
}

async function handleIssue(
  deps: RemoteSessionCapabilityRoutesDeps,
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  sessionId: string
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const authz = await authorizeResourcePermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
    'remote.control'
  )
  if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
  if (!validates(deps.registry, CAPABILITY_ISSUE_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid capability issue request')
  const gate = await beginIdempotency(
    deps.db,
    request,
    reply,
    { organizationId, principalId: principal.subject, method: 'POST', route: CAPABILITIES_ROUTE },
    request.body
  )
  if (!gate) return reply
  const respond = (token: IssuedCapability): unknown => {
    const wire = toTokenWire(token)
    assertResponse(deps.registry, CAPABILITY_TOKEN_SCHEMA_ID, wire)
    void reply
      .code(201)
      .header(
        'location',
        `/v1/organizations/${organizationId}/remote-sessions/${sessionId}/capabilities`
      )
    return wire
  }
  if (gate.priorResourceId) {
    const prior = await getIssuedCapability(
      deps.db,
      organizationId,
      sessionId,
      gate.priorResourceId
    )
    if (!prior) return problem(reply, request, 404, 'NOT_FOUND', 'capability not found')
    return respond(prior)
  }
  const body = request.body as {
    participantId: string
    capability: CapabilityKind
    audience: string
    ttlSeconds?: number
    requiresStepUp?: boolean
  }
  const result = await issueCapability(deps.db, {
    organizationId,
    actorUserId: authz.userId,
    sessionId,
    participantId: body.participantId,
    capability: body.capability,
    audience: body.audience,
    now: new Date(),
    newNonce: newNonce(),
    ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
    ...(body.requiresStepUp !== undefined ? { requiresStepUp: body.requiresStepUp } : {})
  })
  if (!result.ok) {
    await gate.release()
    if (result.reason === 'not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
    if (result.reason === 'forbidden')
      return problem(reply, request, 403, 'FORBIDDEN', 'only the host or an admin may issue')
    if (result.reason === 'session_terminal')
      return problem(
        reply,
        request,
        409,
        'SESSION_TERMINAL',
        'a terminal session issues no capabilities'
      )
    if (result.reason === 'participant_not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'participant not found or left')
    return problem(reply, request, 422, 'STEP_UP_REQUIRED', 'a control capability requires step-up')
  }
  await gate.complete(result.capability.id)
  return respond(result.capability)
}

async function handleRedeem(
  deps: RemoteSessionCapabilityRoutesDeps,
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  sessionId: string
): Promise<unknown> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return reply
  const authz = await authorizeResourcePermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
    'remote.control'
  )
  if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
  if (!validates(deps.registry, CAPABILITY_REDEEM_SCHEMA_ID, request.body))
    return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid capability redeem request')
  const body = request.body as { nonce: string; audience: string }
  const result = await redeemCapability(deps.db, {
    organizationId,
    sessionId,
    nonce: body.nonce,
    audience: body.audience,
    now: new Date()
  })
  if (!result.ok) {
    // doc 34 A2: precise codes — unknown 404, consumed/revoked/audience 409, expired 410 (Gone).
    if (result.reason === 'invalid')
      return problem(reply, request, 404, 'CAPABILITY_INVALID', 'no such capability')
    if (result.reason === 'already_consumed')
      return problem(reply, request, 409, 'CAPABILITY_CONSUMED', 'capability already consumed')
    if (result.reason === 'revoked')
      return problem(reply, request, 409, 'CAPABILITY_REVOKED', 'capability was revoked')
    if (result.reason === 'expired')
      return problem(reply, request, 410, 'CAPABILITY_EXPIRED', 'capability has expired')
    return problem(reply, request, 409, 'CAPABILITY_AUDIENCE_MISMATCH', 'audience does not match')
  }
  const wire = { capability: result.grant.capability, participantId: result.grant.participantId }
  assertResponse(deps.registry, CAPABILITY_GRANT_SCHEMA_ID, wire)
  void reply.code(200)
  return wire
}

export function registerRemoteSessionCapabilityRoutes(
  app: FastifyInstance,
  deps: RemoteSessionCapabilityRoutesDeps
): void {
  // Issue and redeem share the last path segment (`capabilities` / `capabilities:redeem`).
  // find-my-way cannot parse a bare `:suffix` glued after a segment, so — like A1's :transition —
  // the whole final token is one param, split here. Static siblings (participants/consent) still
  // win over this parametric route.
  app.post(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/:capabilityAction',
    async (request, reply) => {
      const { organizationId, sessionId, capabilityAction } = request.params as {
        organizationId: string
        sessionId: string
        capabilityAction: string
      }
      const colon = capabilityAction.indexOf(':')
      const base = colon === -1 ? capabilityAction : capabilityAction.slice(0, colon)
      const action = colon === -1 ? '' : capabilityAction.slice(colon + 1)
      if (base !== 'capabilities')
        return problem(reply, request, 404, 'NOT_FOUND', 'unknown remote session sub-resource')
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(sessionId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      if (action === '') return handleIssue(deps, app, request, reply, organizationId, sessionId)
      if (action === 'redeem')
        return handleRedeem(deps, app, request, reply, organizationId, sessionId)
      return problem(reply, request, 404, 'NOT_FOUND', 'unknown capability action')
    }
  )

  // List a session's capabilities for audit/UI (nonce never exposed). Resource-gated remote.control.
  app.get(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/capabilities',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, sessionId } = request.params as {
        organizationId: string
        sessionId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(sessionId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeResourcePermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        { resourceType: REMOTE_SESSION_RESOURCE_TYPE, resourceId: sessionId },
        'remote.control'
      )
      if (!authz) return reply
      const items = await listSessionCapabilities(deps.db, organizationId, sessionId, new Date())
      const wire = items.map((item) => ({
        id: item.id,
        participantId: item.participantId,
        capability: item.capability,
        audience: item.audience,
        status: item.status,
        requiresStepUp: item.requiresStepUp,
        issuedBy: item.issuedBy,
        expiresAt: item.expiresAt,
        createdAt: item.createdAt,
        consumedAt: item.consumedAt,
        revokedAt: item.revokedAt
      }))
      for (const item of wire) assertResponse(deps.registry, CAPABILITY_SUMMARY_SCHEMA_ID, item)
      return { items: wire, nextCursor: null }
    }
  )
}
