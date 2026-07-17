import {
  getActiveDriver,
  grantDriver,
  revokeDriver,
  type ActiveDriver,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeResourcePermission } from './route-authorization'

// R8 slice A3: single-driver (single-operator) arbitration over the control plane (doc 34 §슬라이스
// A3, §보안 제약 #2 approver≠operator + all takeover audited). Grant/handoff/revoke authority only;
// the Relay/host input gating is a later phase.
const DRIVER_SCHEMA_ID = 'https://schemas.pielab.ai/resources/driver.v1.schema.json'
const DRIVER_GRANT_SCHEMA_ID = 'https://schemas.pielab.ai/resources/driver-grant.v1.schema.json'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REMOTE_SESSION_RESOURCE_TYPE = 'remote_session'

export type RemoteSessionDriverRoutesDeps = {
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

// The current-driver envelope; `driver` is null when no participant holds the role.
function toDriverWire(driver: ActiveDriver | null): Record<string, unknown> {
  return {
    driver: driver
      ? {
          grantId: driver.grantId,
          sessionId: driver.sessionId,
          operatorParticipantId: driver.operatorParticipantId,
          operatorUserId: driver.operatorUserId,
          approverUserId: driver.approverUserId,
          capabilityId: driver.capabilityId,
          grantedAt: driver.grantedAt
        }
      : null
  }
}

export function registerRemoteSessionDriverRoutes(
  app: FastifyInstance,
  deps: RemoteSessionDriverRoutesDeps
): void {
  // Read the current driver (doc 34 A3). Resource-gated remote.control.
  app.get(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/driver',
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
      const driver = await getActiveDriver(deps.db, organizationId, sessionId)
      const wire = toDriverWire(driver)
      assertResponse(deps.registry, DRIVER_SCHEMA_ID, wire)
      return wire
    }
  )

  // Grant / hand off the single driver role (doc 34 A3). Resource-gated remote.control; the store
  // enforces host/admin authority AND the approver≠operator separation. 200 + the active driver.
  app.put(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/driver',
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
      if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
      if (!validates(deps.registry, DRIVER_GRANT_SCHEMA_ID, request.body))
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid driver grant request')
      const body = request.body as { operatorParticipantId: string; capabilityId?: string }
      const result = await grantDriver(deps.db, {
        organizationId,
        approverUserId: authz.userId,
        sessionId,
        operatorParticipantId: body.operatorParticipantId,
        now: new Date(),
        ...(body.capabilityId !== undefined ? { capabilityId: body.capabilityId } : {})
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
        if (result.reason === 'session_terminal')
          return problem(
            reply,
            request,
            409,
            'SESSION_TERMINAL',
            'a terminal session has no driver'
          )
        if (result.reason === 'forbidden')
          return problem(reply, request, 403, 'FORBIDDEN', 'only the host or an admin may grant')
        if (result.reason === 'operator_not_eligible')
          return problem(
            reply,
            request,
            422,
            'OPERATOR_NOT_ELIGIBLE',
            'the operator must be an active control-capable participant'
          )
        // doc 34 §보안 제약 #2: the approver may not make themselves the driver.
        return problem(
          reply,
          request,
          409,
          'APPROVER_IS_OPERATOR',
          'the approver and operator must be different users'
        )
      }
      const wire = toDriverWire(result.driver)
      assertResponse(deps.registry, DRIVER_SCHEMA_ID, wire)
      void reply.code(200)
      return wire
    }
  )

  // Revoke the active driver (doc 07 조작권 회수). Resource-gated remote.control; the store allows
  // host/admin or the driver themselves. 204 idempotent-shaped.
  app.delete(
    '/v1/organizations/:organizationId/remote-sessions/:sessionId/driver',
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
      if (!authz || !authz.userId) return authz ? reply.code(403).send() : reply
      const body = (request.body ?? {}) as { reason?: string }
      const result = await revokeDriver(deps.db, {
        organizationId,
        actorUserId: authz.userId,
        sessionId,
        now: new Date(),
        ...(body.reason !== undefined ? { reason: body.reason } : {})
      })
      if (!result.ok) {
        if (result.reason === 'not_found')
          return problem(reply, request, 404, 'NOT_FOUND', 'remote session not found')
        return problem(
          reply,
          request,
          403,
          'FORBIDDEN',
          'only the host, an admin, or the driver may revoke'
        )
      }
      void reply.code(204).send()
      return reply
    }
  )
}
