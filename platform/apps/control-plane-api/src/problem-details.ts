import { randomBytes } from 'node:crypto'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

// RFC 9457 problem+json. Shape matches contracts/schemas/common/problem-details.v1.
export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

export type ProblemDetails = {
  type: string
  title: string
  status: number
  code: string
  requestId: string
  detail?: string
  instance?: string
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE'
}

function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? `HTTP_${status}`
}

export function buildProblemDetails(input: {
  status: number
  title: string
  code: string
  requestId: string
  detail?: string
  instance?: string
}): ProblemDetails {
  return {
    type: `https://pielab.ai/problems/${input.code.toLowerCase().replaceAll('_', '-')}`,
    title: input.title,
    status: input.status,
    code: input.code,
    requestId: input.requestId,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.instance ? { instance: input.instance } : {})
  }
}

/** Correlation id for a response: the request's trace-id, or a fresh one if the
 *  failure happened before the correlation hook set it. */
export function requestCorrelationId(request: FastifyRequest): string {
  return /^[0-9a-f]{32}$/.test(request.traceId) ? request.traceId : randomBytes(16).toString('hex')
}

export function sendProblem(reply: FastifyReply, problem: ProblemDetails): void {
  void reply.code(problem.status).header('content-type', PROBLEM_CONTENT_TYPE).send(problem)
}

export function registerProblemDetails(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    sendProblem(
      reply,
      buildProblemDetails({
        status: 404,
        title: 'Not Found',
        code: 'NOT_FOUND',
        requestId: requestCorrelationId(request),
        instance: request.url
      })
    )
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500
    const isValidation = Array.isArray(error.validation)
    const code = isValidation ? 'VALIDATION_FAILED' : codeForStatus(status)
    // Why: never leak internal error text on a 500; validation/4xx messages are
    // safe and useful to the caller.
    const safeDetail = status >= 500 ? undefined : error.message
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled request error')
    }
    sendProblem(
      reply,
      buildProblemDetails({
        status,
        title: isValidation ? 'Request validation failed' : (STATUS_CODES[status] ?? 'Error'),
        code,
        requestId: requestCorrelationId(request),
        detail: safeDetail,
        instance: request.url
      })
    )
  })
}
