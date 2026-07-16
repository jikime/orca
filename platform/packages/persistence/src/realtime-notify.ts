// Postgres LISTEN/NOTIFY is the Postgres-only broker between the Worker (publish)
// and the Realtime gateway (delivery) — no Redis/Kafka (ADR-0008). The payload is
// a SMALL pointer (org + assigned sequence), well under Postgres' ~8000-byte
// NOTIFY limit; the gateway fetches the full change row from the DB, which stays
// the source of truth. NOTIFY is lossy on disconnect, so the gateway re-listens
// and does a cursor-based catch-up query after any drop.

export const RESOURCE_CHANGED_CHANNEL = 'pie_resource_changed'

export type ResourceChangedNotification = {
  organizationId: string
  sequence: number
}

export function encodeResourceChangedNotification(
  notification: ResourceChangedNotification
): string {
  return JSON.stringify(notification)
}

export function decodeResourceChangedNotification(
  payload: string
): ResourceChangedNotification | null {
  try {
    const parsed = JSON.parse(payload) as Partial<ResourceChangedNotification>
    if (typeof parsed.organizationId === 'string' && typeof parsed.sequence === 'number') {
      return { organizationId: parsed.organizationId, sequence: parsed.sequence }
    }
  } catch {
    // Malformed notification — the gateway falls back to a catch-up query.
  }
  return null
}
