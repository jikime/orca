import {
  getChannelForMember,
  getChannelKind,
  listChannelMembers,
  removeChannelMember,
  updateChannel,
  type ChannelMemberResource,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const CHANNEL_SCHEMA_ID = 'https://schemas.pielab.ai/resources/channel.v1.schema.json'
const CHANNEL_UPDATE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/channel-update.v1.schema.json'
const CHANNEL_MEMBER_SCHEMA_ID = 'https://schemas.pielab.ai/resources/channel-member.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ChannelManagementRoutesDeps = {
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

function channelEtag(version: number): string {
  return `"channel-${version}"`
}

function ifMatchChannelVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"channel-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

function validates(registry: ContractSchemaRegistry, schemaId: string, body: unknown): boolean {
  const validate = registry.ajv.getSchema(schemaId)
  return !validate || validate(body) === true
}

function assertMemberResponse(
  registry: ContractSchemaRegistry,
  member: ChannelMemberResource
): void {
  const validate = registry.ajv.getSchema(CHANNEL_MEMBER_SCHEMA_ID)
  if (validate && validate(member) !== true) {
    throw new Error(`response violates contract ${CHANNEL_MEMBER_SCHEMA_ID}`)
  }
}

export function registerChannelManagementRoutes(
  app: FastifyInstance,
  deps: ChannelManagementRoutesDeps
): void {
  app.patch('/v1/organizations/:organizationId/channels/:channelId', async (request, reply) => {
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
      'channel.manage'
    )
    if (!authz) return reply
    const expectedVersion = ifMatchChannelVersion(request)
    if (expectedVersion === null) {
      return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
    }
    if (!validates(deps.registry, CHANNEL_UPDATE_SCHEMA_ID, request.body)) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid channel update request')
    }
    const result = await updateChannel(deps.db, {
      organizationId,
      channelId,
      actorUserId: authz.userId ?? organizationId,
      expectedVersion,
      ...(request.body as {
        name?: string
        topic?: string
        description?: string
        archived?: boolean
        retentionDays?: number | null
      })
    })
    if (!result.ok) {
      if (result.reason === 'not_found') {
        return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
      }
      if (result.reason === 'dm_roster_fixed') {
        return problem(reply, request, 409, 'DM_ROSTER_FIXED', 'a direct message cannot be changed')
      }
      return problem(reply, request, 409, 'VERSION_CONFLICT', 'channel was modified concurrently')
    }
    if (!validates(deps.registry, CHANNEL_SCHEMA_ID, result.channel)) {
      throw new Error(`response violates contract ${CHANNEL_SCHEMA_ID}`)
    }
    void reply.header('etag', channelEtag(result.channel.version))
    return result.channel
  })

  app.get(
    '/v1/organizations/:organizationId/channels/:channelId/members',
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
      if (!authz) return reply
      const channel = await getChannelForMember(
        deps.db,
        organizationId,
        channelId,
        authz.userId ?? organizationId
      )
      if (!channel.ok) {
        if (channel.reason === 'not_found') {
          return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
        }
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      const items = await listChannelMembers(deps.db, organizationId, channelId)
      for (const member of items) assertMemberResponse(deps.registry, member)
      return { items }
    }
  )

  app.delete(
    '/v1/organizations/:organizationId/channels/:channelId/members/:userId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, userId } = request.params as {
        organizationId: string
        channelId: string
        userId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(userId)
      ) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      }
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'channel.manage'
      )
      if (!authz) return reply
      const kind = await getChannelKind(deps.db, organizationId, channelId)
      if (kind === null) return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
      if (kind === 'dm') {
        return problem(reply, request, 409, 'DM_ROSTER_FIXED', 'a direct message roster is fixed')
      }
      const result = await removeChannelMember(deps.db, { organizationId, channelId, userId })
      if (result === 'last_owner') {
        return problem(
          reply,
          request,
          409,
          'LAST_CHANNEL_OWNER',
          'the last owner cannot be removed'
        )
      }
      void reply.code(204).send()
      return reply
    }
  )
}
