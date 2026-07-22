import {
  EmailNotVerifiedError,
  getSessionState,
  listMembershipsForMember,
  provisionOwner,
  recordDeviceSession,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import type { VerifiedPrincipal } from './keycloak-token-verifier'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'

const SESSION_STATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/session-state.v1.schema.json'
const MEMBERSHIP_SCHEMA_ID = 'https://schemas.pielab.ai/resources/membership.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type IdentityRoutesDeps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  instanceId: string
}

function problem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  title: string
): void {
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
}

function assertResponseMatchesContract(
  registry: ContractSchemaRegistry,
  schemaId: string,
  body: unknown
): void {
  const validate = registry.ajv.getSchema(schemaId)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${schemaId}`)
  }
}

/**
 * The first real token-authenticated consumers (R3 slice 1). getSessionState and
 * listMemberships judge Pie Membership from the verified subject; provisionOwner
 * is the signup→org bootstrap. The stand-in-header routes (control-plane-routes)
 * are intentionally NOT flipped here — that is slice 3, one concern per slice.
 */
export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRoutesDeps): void {
  app.get('/v1/session', async (request) => {
    // No/invalid token → signed_out (not an error) per the session-state schema.
    const principal = await app.tryAuthenticate(request)
    const state = await getSessionState(deps.db, {
      instanceId: deps.instanceId,
      principal: principal
        ? { issuer: principal.issuer, subject: principal.subject, expiresAt: principal.expiresAt }
        : null
    })
    // Establish the Pie session record (keyed on the token's sid) so revocation can
    // reject this session at the next request even before the token expires.
    if (state.status === 'signed_in' && principal?.sessionId) {
      await recordDeviceSession(deps.db, {
        sessionId: principal.sessionId,
        userId: state.userId,
        issuer: principal.issuer,
        subject: principal.subject
      })
    }
    assertResponseMatchesContract(deps.registry, SESSION_STATE_SCHEMA_ID, state)
    return state
  })

  app.get('/v1/organizations/:organizationId/memberships', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    const { organizationId } = request.params as { organizationId: string }
    const { query, limit } = request.query as { query?: string; limit?: string }
    if (!UUID_PATTERN.test(organizationId)) {
      problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
      return reply
    }
    const result = await listMembershipsForMember(
      deps.db,
      { issuer: principal.issuer, subject: principal.subject, expiresAt: principal.expiresAt },
      organizationId,
      {
        ...(query ? { query } : {}),
        ...(limit && Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {})
      }
    )
    if (!result.ok) {
      // Not a member: 403 without confirming the org's membership topology.
      problem(reply, request, 403, 'FORBIDDEN', 'not a member of this organization')
      return reply
    }
    for (const item of result.items) {
      assertResponseMatchesContract(deps.registry, MEMBERSHIP_SCHEMA_ID, item)
    }
    return { items: result.items, nextCursor: null }
  })

  // CONTRACT GAP: the OpenAPI has no provisioning operation. This is implemented
  // as a to-be-contracted internal route and flagged for the next contracts slice
  // (do not silently extend the OpenAPI file). Signup → org-creation, doc 01:67-79.
  app.post('/v1/provisioning', async (request, reply) => {
    const principal: VerifiedPrincipal | null = await app.requireAuthenticatedSubject(
      request,
      reply
    )
    if (!principal) {
      return reply
    }
    const body = (request.body ?? {}) as { organizationDisplayName?: string }
    try {
      const result = await provisionOwner(deps.db, {
        subject: {
          issuer: principal.issuer,
          subject: principal.subject,
          email: principal.email,
          emailVerified: principal.emailVerified,
          displayName: principal.displayName
        },
        organizationDisplayName: body.organizationDisplayName
      })
      void reply.code(result.created ? 201 : 200)
      return result
    } catch (error) {
      if (error instanceof EmailNotVerifiedError) {
        problem(reply, request, 403, 'EMAIL_NOT_VERIFIED', 'email must be verified to provision')
        return reply
      }
      throw error
    }
  })
}
