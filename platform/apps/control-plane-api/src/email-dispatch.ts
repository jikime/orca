// The email-send seam. Pie owns only its invite and security-alert templates;
// Keycloak owns signup/verification/reset emails (doc 17 :126). R2 defines the
// seam and a dev no-op — it wires NOTHING that actually sends. The eventual shape
// is an outbox-driven email job type that reuses the SKIP LOCKED queue mechanics
// (see queue-retry-policy / queue-polling-loop), with a real provider, persistent
// send queue, and DKIM/SPF/DMARC arriving in R3 (doc 17 :124-130).

export type PieEmailKind = 'organization-invite' | 'security-alert'

export type PieEmailMessage = {
  kind: PieEmailKind
  to: string
  organizationId: string
  // Template variables; never contains a raw credential/verification token — those
  // flows belong to Keycloak.
  data: Record<string, unknown>
}

export type PieEmailDispatchResult = {
  dispatched: boolean
  reason: string
}

export interface PieEmailSender {
  send: (message: PieEmailMessage) => Promise<PieEmailDispatchResult>
}

type MinimalLogger = {
  info: (fields: Record<string, unknown>, message?: string) => void
}

// Mask the recipient before logging: keep the domain and one local char so a log
// line is diagnosable without recording a full address (doc 16 :22 spirit).
function maskRecipient(address: string): string {
  const at = address.indexOf('@')
  if (at <= 0) {
    return '***'
  }
  return `${address[0]}***${address.slice(at)}`
}

/**
 * The only PieEmailSender implementation in R2: a dev no-op that logs the intent
 * structurally and sends nothing. Swapping in a real provider is an R3 change.
 */
export function createLoggingEmailSender(logger: MinimalLogger): PieEmailSender {
  return {
    send: async (message) => {
      logger.info(
        {
          event: 'email.noop',
          kind: message.kind,
          organizationId: message.organizationId,
          to: maskRecipient(message.to)
        },
        'email dispatch skipped (dev no-op)'
      )
      return { dispatched: false, reason: 'dev-noop-sender' }
    }
  }
}
