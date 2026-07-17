import type { AgentEventEnvelope } from '../../shared/agent-event-batch-contract'

// Metadata-only degradation (SYN-002). Under quota pressure a NON-observed event is kept as a
// receipt rather than dropped: its bulky payload body is stripped, but the envelope and a content
// fingerprint (contentHash) are preserved so the server still learns the event existed and can
// match it later. Never inspects/copies payload values beyond the contentHash fingerprint.

const METADATA_ONLY_MARKER = 'metadata_only' as const

function extractContentHash(payload: Record<string, unknown> | undefined): string | undefined {
  const value = payload?.contentHash
  return typeof value === 'string' ? value : undefined
}

/**
 * Returns a copy of `envelope` with the payload body removed, retaining only a contentHash receipt
 * and a degraded marker. Pure — the input envelope is not mutated.
 */
export function stripEnvelopeToMetadata(envelope: AgentEventEnvelope): AgentEventEnvelope {
  const contentHash =
    extractContentHash(envelope.data.payload) ?? extractContentHash(envelope.data.payloadObject)
  const strippedPayload: Record<string, unknown> = { degraded: METADATA_ONLY_MARKER }
  if (contentHash !== undefined) {
    strippedPayload.contentHash = contentHash
  }
  const nextData = { ...envelope.data, payload: strippedPayload }
  delete nextData.payloadObject
  return { ...envelope, data: nextData }
}
