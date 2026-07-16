import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationResource,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const NOTIFICATION_SCHEMA_ID = 'https://schemas.pielab.ai/resources/notification.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type NotificationRoutesDeps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function assertResponse(registry: ContractSchemaRegistry, body: unknown): void {
  const validate = registry.ajv.getSchema(NOTIFICATION_SCHEMA_ID)
  if (validate && validate(body) !== true) {
    throw new Error(`response violates contract ${NOTIFICATION_SCHEMA_ID}`)
  }
}

/**
 * Notifications are the caller's OWN per-user data: the org gate (organization.read)
 * confirms membership, and per-user RLS (user_id = pie.user_id) restricts every read/
 * write to the caller — so no notification-specific permission is needed. mark-read
 * is naturally idempotent, so it does not reserve an idempotency key.
 */
export function registerNotificationRoutes(
  app: FastifyInstance,
  deps: NotificationRoutesDeps
): void {
  app.get('/v1/organizations/:organizationId/notifications', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'organization.read'
    )
    if (!authz) return reply
    if (!authz.userId) return { items: [] as NotificationResource[], nextCursor: null }
    const query = request.query as { cursor?: string; limit?: string; unread?: string }
    if (query.cursor !== undefined && !UUID_PATTERN.test(query.cursor))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid cursor')
    const result = await listNotifications(deps.db, organizationId, authz.userId, {
      ...(query.limit ? { limit: Number(query.limit) } : {}),
      ...(query.cursor ? { afterId: query.cursor } : {}),
      ...(query.unread === 'true' ? { unreadOnly: true } : {})
    })
    for (const item of result.items) assertResponse(deps.registry, item)
    return result
  })

  app.post('/v1/organizations/:organizationId/notifications:read-all', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId } = request.params as { organizationId: string }
    if (!UUID_PATTERN.test(organizationId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid organizationId')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'organization.read'
    )
    if (!authz) return reply
    const updated = authz.userId
      ? await markAllNotificationsRead(deps.db, organizationId, authz.userId)
      : 0
    return { updated }
  })

  app.post(
    '/v1/organizations/:organizationId/notifications/:notificationId/read',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, notificationId } = request.params as {
        organizationId: string
        notificationId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(notificationId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'organization.read'
      )
      if (!authz) return reply
      if (!authz.userId) return problem(reply, request, 404, 'NOT_FOUND', 'notification not found')
      const result = await markNotificationRead(
        deps.db,
        organizationId,
        authz.userId,
        notificationId
      )
      if (!result.ok) return problem(reply, request, 404, 'NOT_FOUND', 'notification not found')
      const response: NotificationResource = result.notification
      assertResponse(deps.registry, response)
      return response
    }
  )
}
