import { createHash } from 'node:crypto'
import {
  completeIdempotencyKey,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  type PieDatabase
} from '@pie/persistence'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'

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

function idempotencyKeyHeader(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && value.length > 0 ? value : null
}

/**
 * The reservation for one delivery mutation. When priorResourceId is set, an
 * earlier identical request already produced that resource — replay it. Otherwise
 * run the mutation, then call complete(id) on success or release() on a business
 * failure (so the key isn't stuck IN_PROGRESS and can be retried).
 */
export type IdempotencyGate = {
  priorResourceId: string | null
  complete: (resourceId: string) => Promise<void>
  release: () => Promise<void>
}

/**
 * Reserves the request's Idempotency-Key over operations.idempotency_records (doc
 * 23:89-99), reusing the same mechanism as artifact intent — NOT a new one. Returns
 * null after sending the terminal response: 400 if the header is missing, 409
 * IDEMPOTENCY_KEY_REUSED for a same-key/different-payload replay, 409
 * IDEMPOTENCY_IN_PROGRESS for a concurrent in-flight duplicate.
 */
export async function beginIdempotency(
  db: PieDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  scope: { organizationId: string; principalId: string; method: string; route: string },
  body: unknown
): Promise<IdempotencyGate | null> {
  const key = idempotencyKeyHeader(request)
  if (!key) {
    problem(reply, request, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required')
    return null
  }
  const full = { ...scope, key }
  const payloadHash = createHash('sha256').update(JSON.stringify(body), 'utf-8').digest('hex')
  const reservation = await reserveIdempotencyKey(db, { ...full, payloadHash })
  if (reservation.outcome === 'conflict') {
    problem(reply, request, 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused with a different payload')
    return null
  }
  if (reservation.outcome === 'in-progress') {
    problem(reply, request, 409, 'IDEMPOTENCY_IN_PROGRESS', 'a matching request is in progress')
    return null
  }
  return {
    priorResourceId: reservation.outcome === 'replay' ? reservation.responseRef : null,
    complete: (resourceId: string) =>
      completeIdempotencyKey(db, { ...full, responseRef: resourceId }),
    release: () => releaseIdempotencyKey(db, full)
  }
}
