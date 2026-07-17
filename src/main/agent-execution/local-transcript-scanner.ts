import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { normalizeSessionTranscript } from '../agent-reconcile/transcript-record-source'
import type { NormalizedTranscriptRecord } from '../agent-reconcile/agent-reconcile-types'
import { scanAiVaultSessions } from '../ai-vault/session-scanner'

// Composes the existing ai-vault local session scanner into the transcript producer the reconciler
// consumes (CAP-001: transcript is a valid complete source on its own). It WRAPS the scanner rather
// than forking it, so a re-scan re-emits the same content-derived records (idempotent). Electron-free
// so the whole subsystem stays unit-testable; the scanner and clock are injected seams.

const DEFAULT_SCAN_LIMIT = 200

export type LocalTranscriptScannerDeps = {
  // The active login's org stamps every record; null when signed out → nothing to attribute.
  getOrganizationId: () => string | null
  clock?: () => number
  hostId?: string
  scanLimit?: number
  scan?: typeof scanAiVaultSessions
}

export function createLocalTranscriptScanner(
  deps: LocalTranscriptScannerDeps
): () => Promise<readonly NormalizedTranscriptRecord[]> {
  const clock = deps.clock ?? Date.now
  const scan = deps.scan ?? scanAiVaultSessions
  const hostId = deps.hostId ?? LOCAL_EXECUTION_HOST_ID
  const scanLimit = deps.scanLimit ?? DEFAULT_SCAN_LIMIT
  return async () => {
    const orgId = deps.getOrganizationId()
    if (!orgId) {
      return []
    }
    const result = await scan({ limit: scanLimit })
    const capturedAt = new Date(clock()).toISOString()
    return result.sessions.flatMap((session) =>
      normalizeSessionTranscript(session, { orgId, hostId, capturedAt })
    )
  }
}
