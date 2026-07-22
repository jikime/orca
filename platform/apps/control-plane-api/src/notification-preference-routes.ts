import {
  getNotificationPreferences,
  setChannelNotificationLevel,
  updateNotificationPreferences,
  type ChannelNotificationLevel,
  type NotificationPreferencesResource,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const PREFERENCES_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/notification-preferences.v1.schema.json'
const PREFERENCES_UPDATE_SCHEMA_ID =
  'https://schemas.pielab.ai/resources/notification-preferences-update.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type NotificationPreferenceRoutesDeps = {
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

function validates(registry: ContractSchemaRegistry, schemaId: string, value: unknown): boolean {
  const validate = registry.ajv.getSchema(schemaId)
  return !validate || validate(value) === true
}

function assertResponse(
  registry: ContractSchemaRegistry,
  response: NotificationPreferencesResource
): void {
  if (!validates(registry, PREFERENCES_SCHEMA_ID, response)) {
    throw new Error(`response violates contract ${PREFERENCES_SCHEMA_ID}`)
  }
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
    return true
  } catch {
    return false
  }
}

export function registerNotificationPreferenceRoutes(
  app: FastifyInstance,
  deps: NotificationPreferenceRoutesDeps
): void {
  app.get('/v1/organizations/:organizationId/notifications/preferences', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
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
      'organization.read'
    )
    if (!authz?.userId) return authz ? reply.code(403).send() : reply
    const response = await getNotificationPreferences(deps.db, organizationId, authz.userId)
    assertResponse(deps.registry, response)
    return response
  })

  app.put('/v1/organizations/:organizationId/notifications/preferences', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
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
      'organization.read'
    )
    if (!authz?.userId) return authz ? reply.code(403).send() : reply
    if (!validates(deps.registry, PREFERENCES_UPDATE_SCHEMA_ID, request.body)) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid preferences update')
    }
    const body = request.body as {
      desktopEnabled?: boolean
      dndEnabled?: boolean
      dndStartMinute?: number
      dndEndMinute?: number
      timezone?: string
    }
    if (body.timezone && !validTimezone(body.timezone)) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid timezone')
    }
    const response = await updateNotificationPreferences(deps.db, {
      organizationId,
      userId: authz.userId,
      ...body
    })
    assertResponse(deps.registry, response)
    return response
  })

  app.put(
    '/v1/organizations/:organizationId/channels/:channelId/notification-level',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId } = request.params as {
        organizationId: string
        channelId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(channelId)) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      }
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'channel.read'
      )
      if (!authz?.userId) return authz ? reply.code(403).send() : reply
      const level = (request.body as { level?: unknown })?.level
      if (level !== 'all' && level !== 'mentions' && level !== 'none') {
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid notification level')
      }
      const result = await setChannelNotificationLevel(deps.db, {
        organizationId,
        channelId,
        userId: authz.userId,
        level: level as ChannelNotificationLevel
      })
      if (result === 'channel_not_found') {
        return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
      }
      if (result === 'not_a_member') {
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      void reply.code(204).send()
      return reply
    }
  )
}
