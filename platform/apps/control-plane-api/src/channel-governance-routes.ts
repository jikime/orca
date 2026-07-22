import {
  applyChannelRetention,
  exportChannelMessages,
  listChannelAuditEntries,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authorizeOrgPermission } from './route-authorization'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { beginIdempotency } from './idempotent-mutation'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RETENTION_ROUTE = '/v1/organizations/{organizationId}/channels/{channelId}/retention:apply'

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

async function authorizeChannelGovernance(
  app: FastifyInstance,
  db: PieDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string
): Promise<{ userId: string | null } | null> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return null
  return authorizeOrgPermission(db, request, reply, principal, organizationId, 'channel.manage')
}

export function registerChannelGovernanceRoutes(
  app: FastifyInstance,
  deps: { db: PieDatabase }
): void {
  app.get('/v1/organizations/:organizationId/channels/:channelId/audit', async (request, reply) => {
    const { organizationId, channelId } = request.params as {
      organizationId: string
      channelId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(channelId)) {
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    }
    if (!(await authorizeChannelGovernance(app, deps.db, request, reply, organizationId))) {
      return reply
    }
    return { items: await listChannelAuditEntries(deps.db, organizationId, channelId) }
  })

  app.get(
    '/v1/organizations/:organizationId/channels/:channelId/export',
    async (request, reply) => {
      const { organizationId, channelId } = request.params as {
        organizationId: string
        channelId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(channelId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      }
      if (!(await authorizeChannelGovernance(app, deps.db, request, reply, organizationId))) {
        return reply
      }
      return exportChannelMessages(deps.db, organizationId, channelId)
    }
  )

  app.post(
    '/v1/organizations/:organizationId/channels/:channelId/retention:apply',
    async (request, reply) => {
      const { organizationId, channelId } = request.params as {
        organizationId: string
        channelId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(channelId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      }
      const authz = await authorizeChannelGovernance(app, deps.db, request, reply, organizationId)
      if (!authz) return reply
      const gate = await beginIdempotency(
        deps.db,
        request,
        reply,
        {
          organizationId,
          principalId: authz.userId ?? organizationId,
          method: 'POST',
          route: RETENTION_ROUTE
        },
        {}
      )
      if (!gate) return reply
      if (gate.priorResourceId?.startsWith('retention:')) {
        return { ok: true, redactedCount: Number(gate.priorResourceId.slice(10)) }
      }
      let result: Awaited<ReturnType<typeof applyChannelRetention>>
      try {
        result = await applyChannelRetention(deps.db, {
          organizationId,
          channelId,
          actorUserId: authz.userId
        })
      } catch (error) {
        await gate.release()
        throw error
      }
      if (!result.ok) {
        await gate.release()
        return result.reason === 'not_found'
          ? problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
          : problem(reply, request, 409, 'RETENTION_DISABLED', 'channel retention is disabled')
      }
      await gate.complete(`retention:${result.redactedCount}`)
      return result
    }
  )
}
