import type { AiVaultSession, AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import { stableHash } from './agent-reconcile-envelope'
import type { NormalizedTranscriptRecord, TranscriptRecordKind } from './agent-reconcile-types'

// Thin adapter over an ai-vault scanned session → the normalized records the reconciler consumes.
// It WRAPS the scanner (does not fork it): a remote session's records flow through unchanged, so
// SSH/remote transcripts reconcile the same way as local ones.

export type TranscriptSourceContext = {
  orgId: string
  hostId: string
  // When Pie captured this scan. Injected (no clock here) so mapping stays deterministic.
  capturedAt: string
}

// Injected scanner seam: production passes an ai-vault session scanner; tests pass a fixture loader.
export type SessionTranscriptScan = (args: {
  agent: AiVaultSession['agent']
  sessionId: string
}) => Promise<AiVaultSession | null>

const ROLE_TO_KIND: Partial<Record<AiVaultSessionPreviewMessage['role'], TranscriptRecordKind>> = {
  user: 'user_prompt',
  assistant: 'assistant_message',
  tool: 'tool_call'
}

// Pure projection of a scanned session's preview messages into normalized transcript records.
// `providerRecordKey` is `${sessionId}:${index}` — stable on a re-scan (idempotent) but distinct
// across sessions, so a same-text re-run in a new session is a distinct event. contentHash is over
// the message text (hashed, never stored/logged in the clear).
export function normalizeSessionTranscript(
  session: AiVaultSession,
  ctx: TranscriptSourceContext
): NormalizedTranscriptRecord[] {
  const records: NormalizedTranscriptRecord[] = []
  let turnRef: string | null = null

  session.previewMessages.forEach((message, index) => {
    const kind = ROLE_TO_KIND[message.role]
    if (!kind) {
      // system/unknown rows are not part of the reconciled turn timeline.
      return
    }
    const providerRecordKey = `${session.sessionId}:${index}`
    if (kind === 'user_prompt') {
      // A user prompt opens a turn; following assistant/tool rows attach to it via turnRef.
      turnRef = providerRecordKey
    }
    const resolvedTurnRef = turnRef ?? `${session.sessionId}:turn:${index}`
    const occurredAt = message.timestamp ?? session.modifiedAt

    records.push({
      provider: session.agent,
      sessionId: session.sessionId,
      kind,
      providerRecordKey,
      turnRef: resolvedTurnRef,
      sequence: index,
      contentHash: stableHash([message.text]),
      occurredAt,
      capturedAt: ctx.capturedAt,
      orgId: ctx.orgId,
      hostId: ctx.hostId,
      ...(kind === 'tool_call' ? { toolCallRef: providerRecordKey } : {})
    })
  })

  return records
}

export type TranscriptRecordSource = {
  load: (args: {
    agent: AiVaultSession['agent']
    sessionId: string
    ctx: TranscriptSourceContext
  }) => Promise<NormalizedTranscriptRecord[]>
}

// Wraps the injected scanner. TODO(pie-r5-s3-live): the live transcript watcher supplies `scan`
// (a real ai-vault session scanner, local or remote) and pushes the result into the reconciler.
export function createTranscriptRecordSource(scan: SessionTranscriptScan): TranscriptRecordSource {
  return {
    load: async ({ agent, sessionId, ctx }) => {
      const session = await scan({ agent, sessionId })
      if (!session) {
        return []
      }
      return normalizeSessionTranscript(session, ctx)
    }
  }
}
