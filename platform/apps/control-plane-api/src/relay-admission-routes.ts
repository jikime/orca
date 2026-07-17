import { redeemCapability, type PieDatabase } from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { extractBearerToken } from './request-authentication'

// R8 slice B2: the operator-authenticated Relay (a machine, not a user) redeems a client-presented
// capability here before admitting a stream (doc 34 B2, §보안 제약 #5 E2EE). This is NOT the
// user-facing resource-gated redeem route — the Relay authenticates with the operator bearer, and the
// redemption is single-use, tenant-scoped, and leaks nothing beyond the granted action.
const RELAY_ADMIT_SCHEMA_ID = 'https://schemas.pielab.ai/resources/relay-admit.v1.schema.json'
const RELAY_ADMIT_RESULT_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/relay-admit-result.v1.schema.json'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RelayAdmissionRoutesDeps = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  // Operator bearer that gates this internal route. Capability redemption is NEVER exposed to
  // unauthenticated callers, so when it is unset the route fails closed (401) rather than opening.
  operatorToken?: string
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

export function registerRelayAdmissionRoutes(
  app: FastifyInstance,
  deps: RelayAdmissionRoutesDeps
): void {
  const validateRequest = deps.registry.ajv.getSchema(RELAY_ADMIT_SCHEMA_ID)
  const validateResult = deps.registry.ajv.getSchema(RELAY_ADMIT_RESULT_SCHEMA_ID)

  // Operator authz: fail closed unless a bearer is configured AND matches. Constant-time is not
  // needed here (the operator token is a deployment secret, not a per-request nonce), but it is never
  // logged.
  const authorizeOperator = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (
      deps.operatorToken &&
      extractBearerToken(request.headers.authorization) === deps.operatorToken
    ) {
      return true
    }
    void reply.code(401).send({ code: 'UNAUTHENTICATED', status: 401 })
    return false
  }

  app.post('/internal/remote-sessions/:sessionId/relay-admit', async (request, reply) => {
    if (!authorizeOperator(request, reply)) return reply
    const { sessionId } = request.params as { sessionId: string }
    if (!UUID_PATTERN.test(sessionId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid session id')
    if (validateRequest && validateRequest(request.body) !== true)
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid relay admission request')
    const body = request.body as { nonce: string; audience: string; organizationId: string }
    if (!UUID_PATTERN.test(body.organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organization id')

    // Tenant/RLS: the Relay supplies organizationId (obtained from the client-presented credential).
    // redeemCapability opens a tenant tx scoped to that org, so a wrong/mismatched org simply finds no
    // capability row (→ invalid) — the redeem is RLS-safe and fails closed by construction.
    const result = await redeemCapability(deps.db, {
      organizationId: body.organizationId,
      sessionId,
      nonce: body.nonce,
      audience: body.audience,
      now: new Date()
    })
    if (!result.ok) {
      // doc 34 B2: precise but minimal — invalid/consumed/revoked/audience → 409, expired → 410 (Gone).
      if (result.reason === 'expired')
        return problem(reply, request, 410, 'CAPABILITY_EXPIRED', 'capability has expired')
      if (result.reason === 'already_consumed')
        return problem(reply, request, 409, 'CAPABILITY_CONSUMED', 'capability already consumed')
      if (result.reason === 'revoked')
        return problem(reply, request, 409, 'CAPABILITY_REVOKED', 'capability was revoked')
      if (result.reason === 'audience_mismatch')
        return problem(
          reply,
          request,
          409,
          'CAPABILITY_AUDIENCE_MISMATCH',
          'audience does not match'
        )
      return problem(reply, request, 409, 'CAPABILITY_INVALID', 'no such capability')
    }
    const wire = { participantId: result.grant.participantId, capability: result.grant.capability }
    if (validateResult && validateResult(wire) !== true)
      throw new Error(`response violates contract ${RELAY_ADMIT_RESULT_SCHEMA_ID}`)
    void reply.code(200)
    return wire
  })
}
