import { createHash, createPublicKey } from 'node:crypto'
import { registerInstallationKey, type PieDatabase } from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { beginIdempotency } from './idempotent-mutation'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

// R5 slice 2b: the producer registers its per-installation Ed25519 PUBLIC key (doc 24 anti-forgery)
// so the Control Plane can verify signed ExecutionContexts. Reuses the agent_event.ingest gate —
// the same producer that will feed events registers the key it signs with. The server computes the
// key fingerprint itself (identical to the client's computePublicKeyId) so the id is authoritative.

const INSTALLATION_KEY_REGISTER_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/installation-key-register-request.v1.schema.json'
const INSTALLATION_KEY_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/installation-key.v1.schema.json'
const INSTALLATION_KEYS_ROUTE = '/v1/organizations/{organizationId}/installation-keys'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type InstallationKeyRoutesDeps = {
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

// The key fingerprint MUST match the client's computePublicKeyId: base64url(sha256(SPKI DER)).
// Computed server-side from the registered PEM so a rotated key surfaces a distinct id.
function computePublicKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' })
  return createHash('sha256').update(der).digest('base64url')
}

export function registerInstallationKeyRoutes(
  app: FastifyInstance,
  deps: InstallationKeyRoutesDeps
): void {
  app.post('/v1/organizations/:organizationId/installation-keys', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) {
      return reply
    }
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId)) {
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    }
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'agent_event.ingest'
    )
    if (!authz || !authz.userId) {
      return authz ? reply.code(403).send() : reply
    }
    if (!validates(deps.registry, INSTALLATION_KEY_REGISTER_SCHEMA_ID, request.body)) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid installation key request')
    }
    const body = request.body as { installationId: string; publicKey: string; algorithm: 'ed25519' }
    // Reject a PEM the runtime cannot parse as a public key before it reaches the store.
    let publicKeyId: string
    try {
      publicKeyId = computePublicKeyId(body.publicKey)
    } catch {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'publicKey is not a valid PEM')
    }
    const gate = await beginIdempotency(
      deps.db,
      request,
      reply,
      {
        organizationId,
        principalId: principal.subject,
        method: 'POST',
        route: INSTALLATION_KEYS_ROUTE
      },
      request.body
    )
    if (!gate) {
      return reply
    }
    const respond = (id: string, rotated: boolean, created: boolean): Record<string, unknown> => {
      const wire = { id, installationId: body.installationId, publicKeyId, rotated }
      assertResponse(deps.registry, INSTALLATION_KEY_SCHEMA_ID, wire)
      void reply
        .code(created ? 201 : 200)
        .header('location', `/v1/organizations/${organizationId}/installation-keys/${id}`)
      return wire
    }
    // A same-key/same-payload replay returns the prior row without re-running (a re-run would bump
    // rotation_count). publicKeyId is deterministic from the body, so no DB re-read is needed.
    if (gate.priorResourceId) {
      return respond(gate.priorResourceId, false, false)
    }
    const result = await registerInstallationKey(deps.db, {
      organizationId,
      userId: authz.userId,
      installationId: body.installationId,
      publicKeyPem: body.publicKey,
      publicKeyId
    })
    await gate.complete(result.id)
    return respond(result.id, result.rotated, !result.rotated)
  })
}
