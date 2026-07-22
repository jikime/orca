import {
  addMeetingParticipant,
  createMeetingGuestSession,
  createMeetingGuestLink,
  findMeetingGuestLinkIdByToken,
  getMeeting,
  getMeetingParticipantForUser,
  getUserIdForSubject,
  listMeetingGuestLinks,
  resolveMeetingGuestLink,
  revokeMeetingGuestLink,
  type MeetingGuestIdentityMode,
  type MeetingGuestVisibility,
  type PublicMeetingGuestContext,
  type PieDatabase
} from '@pie/persistence'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import { authorizeOrgPermission } from './route-authorization'

const LINK_SCHEMA = 'https://schemas.pielab.ai/resources/meeting-guest-link.v1.schema.json'
const CREATE_SCHEMA = 'https://schemas.pielab.ai/resources/meeting-guest-link-create.v1.schema.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Deps = { db: PieDatabase; registry: ContractSchemaRegistry }

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

function assertLink(deps: Deps, value: unknown): void {
  const validate = deps.registry.ajv.getSchema(LINK_SCHEMA)
  if (validate && validate(value) !== true) throw new Error('guest link violates contract')
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const raw = request.headers['if-match']
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value ? /^"meeting-guest-link-(\d+)"$/.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

async function authorize(
  app: FastifyInstance,
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: string
): Promise<{ organizationId: string; userId: string } | null> {
  const principal = await app.requireAuthenticatedSubject(request, reply)
  if (!principal) return null
  const { organizationId } = request.params as { organizationId: string }
  if (!UUID_PATTERN.test(organizationId)) {
    problem(reply, request, 400, 'BAD_REQUEST', 'invalid organization id')
    return null
  }
  const auth = await authorizeOrgPermission(
    deps.db,
    request,
    reply,
    principal,
    organizationId,
    permission
  )
  return auth?.userId ? { organizationId, userId: auth.userId } : null
}

export function registerMeetingGuestLinkRoutes(app: FastifyInstance, deps: Deps): void {
  app.get(
    '/v1/organizations/:organizationId/meetings/:meetingId/guest-links',
    async (request, reply) => {
      const auth = await authorize(app, deps, request, reply, 'meeting.read')
      if (!auth) return reply
      const { meetingId } = request.params as { meetingId: string }
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      const items = await listMeetingGuestLinks(deps.db, auth.organizationId, meetingId)
      items.forEach((item) => assertLink(deps, item))
      return { items, nextCursor: null }
    }
  )

  app.post(
    '/v1/organizations/:organizationId/meetings/:meetingId/guest-links',
    async (request, reply) => {
      const auth = await authorize(app, deps, request, reply, 'meeting.manage')
      if (!auth) return reply
      const { meetingId } = request.params as { meetingId: string }
      if (!UUID_PATTERN.test(meetingId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid meeting id')
      const validate = deps.registry.ajv.getSchema(CREATE_SCHEMA)
      if (validate && validate(request.body) !== true)
        return problem(reply, request, 400, 'VALIDATION_FAILED', 'invalid guest link')
      const meeting = await getMeeting(deps.db, auth.organizationId, meetingId)
      if (!meeting) return problem(reply, request, 404, 'NOT_FOUND', 'meeting not found')
      const body = request.body as {
        identityMode: MeetingGuestIdentityMode
        visibility: MeetingGuestVisibility
        expiresInHours: number
      }
      const result = await createMeetingGuestLink(deps.db, {
        organizationId: auth.organizationId,
        meetingId,
        actorUserId: auth.userId,
        ...body
      })
      assertLink(deps, result.link)
      return reply.code(201).send(result)
    }
  )

  app.post(
    '/v1/organizations/:organizationId/meeting-guest-links/:linkTarget',
    async (request, reply) => {
      const auth = await authorize(app, deps, request, reply, 'meeting.manage')
      if (!auth) return reply
      const { linkTarget } = request.params as { linkTarget: string }
      const [linkId, action] = linkTarget.split(':')
      if (action !== 'revoke') return problem(reply, request, 404, 'NOT_FOUND', 'unknown action')
      if (!linkId || !UUID_PATTERN.test(linkId))
        return problem(reply, request, 400, 'BAD_REQUEST', 'invalid link id')
      const version = ifMatchVersion(request)
      if (version === null)
        return problem(reply, request, 428, 'IF_MATCH_REQUIRED', 'If-Match is required')
      const outcome = await revokeMeetingGuestLink(deps.db, {
        organizationId: auth.organizationId,
        linkId,
        actorUserId: auth.userId,
        expectedVersion: version
      })
      if (outcome === 'not_found')
        return problem(reply, request, 404, 'NOT_FOUND', 'guest link not found')
      if (outcome === 'version_conflict')
        return problem(reply, request, 409, 'VERSION_CONFLICT', 'guest link changed')
      return { outcome }
    }
  )

  app.post('/v1/public/meeting-guest-links:resolve', async (request, reply) => {
    const token = (request.body as { token?: unknown } | null)?.token
    if (typeof token !== 'string' || token.length < 32)
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'guest token required')
    const result = await resolveMeetingGuestLink(deps.db, token)
    if (!result.ok) {
      const status = result.reason === 'invalid' ? 404 : 410
      return problem(
        reply,
        request,
        status,
        `GUEST_LINK_${result.reason.toUpperCase()}`,
        result.reason
      )
    }
    const { organizationId: _organizationId, ...publicContext } = result.context
    return publicContext
  })

  app.post('/v1/meeting-guest-links:redeem', async (request, reply) => {
    const principal = await app.requireAuthenticatedSubject(request, reply)
    if (!principal) return reply
    const token = (request.body as { token?: unknown } | null)?.token
    if (typeof token !== 'string')
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'guest token required')
    const resolved = await resolveMeetingGuestLink(deps.db, token)
    if (!resolved.ok) return problem(reply, request, 410, 'GUEST_LINK_UNAVAILABLE', resolved.reason)
    if (resolved.context.identityMode !== 'account_required')
      return problem(reply, request, 409, 'GUEST_IDENTITY_MODE', 'use limited guest redemption')
    const userId = await getUserIdForSubject(deps.db, principal.issuer, principal.subject)
    if (!userId)
      return problem(reply, request, 403, 'ACCOUNT_REQUIRED', 'provisioned Pie account required')
    return redeemGuest(deps, request, reply, {
      token,
      context: resolved.context,
      userId,
      displayName: principal.displayName,
      email: principal.email
    })
  })

  app.post('/v1/public/meeting-guests:redeem', async (request, reply) => {
    const body = request.body as {
      token?: unknown
      displayName?: unknown
      email?: unknown
    } | null
    if (
      typeof body?.token !== 'string' ||
      typeof body.displayName !== 'string' ||
      body.displayName.trim().length < 1
    ) {
      return problem(reply, request, 400, 'VALIDATION_FAILED', 'token and displayName required')
    }
    const resolved = await resolveMeetingGuestLink(deps.db, body.token)
    if (!resolved.ok) return problem(reply, request, 410, 'GUEST_LINK_UNAVAILABLE', resolved.reason)
    if (resolved.context.identityMode !== 'limited_guest')
      return problem(reply, request, 401, 'ACCOUNT_REQUIRED', 'Pie account sign-in required')
    return redeemGuest(deps, request, reply, {
      token: body.token,
      context: resolved.context,
      userId: randomUUID(),
      displayName: body.displayName.trim().slice(0, 120),
      email: typeof body.email === 'string' ? body.email.trim().slice(0, 320) : null
    })
  })
}

async function redeemGuest(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    token: string
    context: Pick<
      PublicMeetingGuestContext,
      'organizationId' | 'meetingId' | 'identityMode' | 'visibility'
    >
    userId: string
    displayName: string
    email: string | null
  }
): Promise<unknown> {
  const guestLinkId = await findMeetingGuestLinkIdByToken(deps.db, input.token)
  if (!guestLinkId)
    return problem(reply, request, 404, 'GUEST_LINK_INVALID', 'guest link is invalid')
  const added = await addMeetingParticipant(deps.db, {
    organizationId: input.context.organizationId,
    actorUserId: input.userId,
    meetingId: input.context.meetingId,
    userId: input.userId,
    role: 'participant'
  })
  const participant = added.ok
    ? added.participant
    : await getMeetingParticipantForUser(
        deps.db,
        input.context.organizationId,
        input.context.meetingId,
        input.userId
      )
  if (!participant)
    return problem(reply, request, 409, 'GUEST_REDEEM_FAILED', 'could not add guest')
  const created = await createMeetingGuestSession(deps.db, {
    organizationId: input.context.organizationId,
    guestLinkId,
    meetingId: input.context.meetingId,
    userId: input.userId,
    displayName: input.displayName,
    email: input.email
  })
  if (!created)
    return problem(reply, request, 410, 'GUEST_LINK_UNAVAILABLE', 'guest link is unavailable')
  return reply.code(201).send({
    accessToken: created.accessToken,
    expiresAt: created.session.expiresAt,
    meetingId: input.context.meetingId,
    visibility: input.context.visibility,
    participant
  })
}
