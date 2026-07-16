import { randomBytes } from 'node:crypto'

// W3C Trace Context traceparent: version-traceid-spanid-flags.
const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/

export type TraceContext = {
  traceparent: string
  traceId: string
}

function newTraceId(): string {
  return randomBytes(16).toString('hex')
}

function newSpanId(): string {
  return randomBytes(8).toString('hex')
}

/**
 * Adopts a valid inbound `traceparent` (reusing its trace-id) or mints a fresh
 * one. The trace-id doubles as the request correlation id echoed in logs and
 * problem+json. An all-zero trace-id is rejected as invalid per the spec.
 */
export function resolveTraceContext(inbound: string | undefined): TraceContext {
  if (inbound) {
    const match = TRACEPARENT_PATTERN.exec(inbound)
    const traceId = match?.[1]
    if (traceId && !/^0+$/.test(traceId)) {
      return { traceparent: inbound, traceId }
    }
  }
  const traceId = newTraceId()
  return { traceparent: `00-${traceId}-${newSpanId()}-01`, traceId }
}
