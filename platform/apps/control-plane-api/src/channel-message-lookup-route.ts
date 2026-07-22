import { getChannelForMember, getMessageWithReactions, type PieDatabase } from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const MESSAGE_SCHEMA_ID = 'https://schemas.pielab.ai/resources/message.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ChannelMessageLookupRouteDeps = {
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

export function registerChannelMessageLookupRoute(
  app: FastifyInstance,
  deps: ChannelMessageLookupRouteDeps
): void {
  app.get(
    '/v1/organizations/:organizationId/channels/:channelId/messages/:messageId',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId, messageId } = request.params as {
        organizationId: string
        channelId: string
        messageId: string
      }
      if (
        !UUID_PATTERN.test(organizationId) ||
        !UUID_PATTERN.test(channelId) ||
        !UUID_PATTERN.test(messageId)
      ) {
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      }
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'message.read'
      )
      if (!authz) return reply
      const userId = authz.userId ?? organizationId
      const channel = await getChannelForMember(deps.db, organizationId, channelId, userId)
      if (!channel.ok) {
        if (channel.reason === 'not_found') {
          return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
        }
        return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
      }
      const message = await getMessageWithReactions(deps.db, organizationId, messageId, userId)
      if (!message || message.channelId !== channelId) {
        return problem(reply, request, 404, 'NOT_FOUND', 'message not found')
      }
      const validate = deps.registry.ajv.getSchema(MESSAGE_SCHEMA_ID)
      if (validate && validate(message) !== true) {
        throw new Error(`response violates contract ${MESSAGE_SCHEMA_ID}`)
      }
      return message
    }
  )
}
