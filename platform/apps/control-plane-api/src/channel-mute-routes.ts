import {
  muteChannel,
  unmuteChannel,
  type ChannelMuteResult,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ChannelMuteRoutesDeps = {
  db: PieDatabase
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

// The member-gate outcome is identical for mute and unmute: 404 if the channel does not
// exist, 403 if the caller is not on its roster. Success is a bodyless 204 either way
// (both operations are idempotent by nature, like reaction remove — no key reserved).
function respondMuteResult(
  reply: FastifyReply,
  request: FastifyRequest,
  result: ChannelMuteResult
): FastifyReply {
  if (!result.ok) {
    if (result.reason === 'channel_not_found')
      return problem(reply, request, 404, 'NOT_FOUND', 'channel not found')
    return problem(reply, request, 403, 'FORBIDDEN', 'not a member of this channel')
  }
  void reply.code(204).send()
  return reply
}

/**
 * Per-user channel mute: suppresses @channel/@here broadcast notifications from a channel
 * for the caller (a direct @mention still notifies them). Both verbs require message.read
 * — any member who can read a channel may mute it — then the store's roster member-gate.
 * Idempotent by nature, so neither reserves an Idempotency-Key (reaction-remove pattern).
 */
export function registerChannelMuteRoutes(app: FastifyInstance, deps: ChannelMuteRoutesDeps): void {
  app.put('/v1/organizations/:organizationId/channels/:channelId/mute', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const { organizationId, channelId } = request.params as {
      organizationId: string
      channelId: string
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(channelId))
      return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
    const authz = await authorizeOrgPermission(
      deps.db,
      request,
      reply,
      principal,
      organizationId,
      'message.read'
    )
    if (!authz) return reply
    const result = await muteChannel(deps.db, {
      organizationId,
      channelId,
      userId: authz.userId ?? organizationId
    })
    return respondMuteResult(reply, request, result)
  })

  app.delete(
    '/v1/organizations/:organizationId/channels/:channelId/mute',
    async (request, reply) => {
      const principal = await app.requireAuthenticatedSubject(request, reply)
      if (!principal) return reply
      const { organizationId, channelId } = request.params as {
        organizationId: string
        channelId: string
      }
      if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(channelId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid id')
      const authz = await authorizeOrgPermission(
        deps.db,
        request,
        reply,
        principal,
        organizationId,
        'message.read'
      )
      if (!authz) return reply
      const result = await unmuteChannel(deps.db, {
        organizationId,
        channelId,
        userId: authz.userId ?? organizationId
      })
      return respondMuteResult(reply, request, result)
    }
  )
}
