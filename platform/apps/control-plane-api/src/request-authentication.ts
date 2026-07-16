import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { buildProblemDetails, requestCorrelationId, sendProblem } from './problem-details'
import type { KeycloakTokenVerifier, VerifiedPrincipal } from './keycloak-token-verifier'

/** Extracts a bearer token from an Authorization header value (or null). */
export function extractBearerToken(rawHeader: string | string[] | undefined): string | null {
  const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
  if (!value) {
    return null
  }
  const match = /^Bearer (.+)$/i.exec(value.trim())
  return match ? match[1]!.trim() : null
}

function bearerToken(request: FastifyRequest): string | null {
  return extractBearerToken(request.headers.authorization)
}

declare module 'fastify' {
  interface FastifyInstance {
    // Verifies the bearer token if present; returns null on absent/invalid token
    // WITHOUT erroring — for endpoints (session) that report signed_out instead.
    tryAuthenticate: (request: FastifyRequest) => Promise<VerifiedPrincipal | null>
    // Verifies and REQUIRES a valid token; sends 401 problem+json and returns null
    // when absent/invalid — for endpoints that must have an authenticated subject.
    requireAuthenticatedSubject: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<VerifiedPrincipal | null>
  }
}

/**
 * Registers the token-verification decorations. Verification failures are treated
 * uniformly as "unauthenticated" — the reason is never echoed to the caller so a
 * probe cannot distinguish expired vs tampered vs wrong-issuer. Routes decide
 * whether that means signed_out (tryAuthenticate) or 401 (requireAuthenticated).
 */
export function registerRequestAuthentication(
  app: FastifyInstance,
  verifier: KeycloakTokenVerifier
): void {
  const tryAuthenticate = async (request: FastifyRequest): Promise<VerifiedPrincipal | null> => {
    const token = bearerToken(request)
    if (!token) {
      return null
    }
    try {
      return await verifier.verify(token)
    } catch {
      return null
    }
  }

  app.decorate('tryAuthenticate', tryAuthenticate)
  app.decorate(
    'requireAuthenticatedSubject',
    async (request: FastifyRequest, reply: FastifyReply): Promise<VerifiedPrincipal | null> => {
      const principal = await tryAuthenticate(request)
      if (!principal) {
        sendProblem(
          reply,
          buildProblemDetails({
            status: 401,
            title: 'authentication required',
            code: 'UNAUTHENTICATED',
            requestId: requestCorrelationId(request),
            instance: request.url
          })
        )
        return null
      }
      return principal
    }
  )
}
