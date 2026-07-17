import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import { stableHash } from '../agent-reconcile/agent-reconcile-envelope'
import type { HookEventKind, NormalizedHookEvent } from '../agent-reconcile/agent-reconcile-types'

// The LIVE managed-hook producer: maps each applied AgentHookEventPayload (the second source
// alongside the transcript scanner) into a NormalizedHookEvent and buffers it in a bounded ring the
// reconcile cycle drains. Strictly inert until start() subscribes — only while the dev-gated
// subsystem runs — and unsubscribes on stop() so nothing leaks. Never logs prompt/tool CONTENT: any
// content that shapes an id is hashed, never stored raw.

// Claude Code and Codex share these raw hook event names; only the four turn-timeline kinds map. Any
// other event (PermissionRequest, SubagentStop, SessionEnd, unknown, absent) is skipped — the tap
// never fabricates a kind.
const HOOK_EVENT_NAME_TO_KIND: Readonly<Record<string, HookEventKind>> = {
  UserPromptSubmit: 'user_prompt',
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  Stop: 'stop'
}

export function mapHookEventNameToKind(hookEventName: string | undefined): HookEventKind | null {
  if (!hookEventName) {
    return null
  }
  return HOOK_EVENT_NAME_TO_KIND[hookEventName] ?? null
}

const DEFAULT_RING_SIZE = 512

export type AgentHookEventSubscribe = (
  listener: (payload: AgentHookEventPayload) => void
) => () => void

export type AgentHookEventTapDeps = {
  clock: () => number
  // The active login's org stamps every event; null when signed out → nothing to attribute.
  getOrganizationId: () => string | null
  ringSize?: number
}

export type AgentHookEventTap = {
  start: (subscribe: AgentHookEventSubscribe) => void
  ingest: (payload: AgentHookEventPayload) => void
  drain: () => NormalizedHookEvent[]
  stop: () => void
}

function isToolKind(kind: HookEventKind): boolean {
  return kind === 'pre_tool' || kind === 'post_tool'
}

// STABLE per emission: identical on a replay, distinct on a genuine re-run — seeded ONLY from the
// payload's own identity (session, per-turn interaction key, tool call id, hashed turn content),
// NEVER from Date.now/random, so the reconciler's outbox dedupe (CAP-003) holds across restarts.
function deriveProviderRecordKey(args: {
  kind: HookEventKind
  sessionId: string
  payload: AgentHookEventPayload
  toolCallRef: string | undefined
}): string {
  const { kind, sessionId, payload, toolCallRef } = args
  if (isToolKind(kind) && toolCallRef) {
    return `${kind}:${toolCallRef}`
  }
  const interaction = payload.promptInteractionKey?.trim()
  if (interaction) {
    return `${kind}:${interaction}`
  }
  // No source-provided per-turn key: hash the turn's identity (content is hashed, never stored raw).
  return `${kind}:${stableHash([sessionId, payload.payload.prompt ?? '']).slice(0, 24)}`
}

export function createAgentHookEventTap(deps: AgentHookEventTapDeps): AgentHookEventTap {
  const ringSize = deps.ringSize ?? DEFAULT_RING_SIZE
  const buffer: NormalizedHookEvent[] = []
  let unsubscribe: (() => void) | null = null
  // Per-session ordinal + current turnRef mirror the transcript source: a user_prompt opens a turn
  // (turnRef = its own record key) and later tool/stop events inherit it, so hook and transcript
  // records of one turn line up on the same turnRef and fold to one turn (CAP-003).
  const sequenceBySession = new Map<string, number>()
  const turnRefBySession = new Map<string, string>()

  const nextSequence = (sessionId: string): number => {
    const next = sequenceBySession.get(sessionId) ?? 0
    sequenceBySession.set(sessionId, next + 1)
    return next
  }

  const toNormalized = (payload: AgentHookEventPayload): NormalizedHookEvent | null => {
    const kind = mapHookEventNameToKind(payload.hookEventName)
    if (!kind) {
      return null
    }
    const provider = payload.payload.agentType?.trim()
    if (!provider || provider === 'unknown') {
      return null
    }
    const sessionId = payload.providerSession?.id
    if (!sessionId) {
      return null
    }
    const orgId = deps.getOrganizationId()
    if (!orgId) {
      return null
    }

    // Respect the event's origin: a relay-forwarded event carries a connectionId; don't assume local.
    const hostId = payload.connectionId
      ? toSshExecutionHostId(payload.connectionId)
      : LOCAL_EXECUTION_HOST_ID
    const toolName = payload.payload.toolName?.trim() || undefined
    const toolCallRef = isToolKind(kind)
      ? payload.toolUseId?.trim() ||
        stableHash([sessionId, toolName ?? '', payload.payload.toolInput ?? '']).slice(0, 24)
      : undefined
    const providerRecordKey = deriveProviderRecordKey({ kind, sessionId, payload, toolCallRef })

    let turnRef: string
    if (kind === 'user_prompt') {
      turnRef = providerRecordKey
      turnRefBySession.set(sessionId, turnRef)
    } else {
      turnRef = turnRefBySession.get(sessionId) ?? providerRecordKey
    }

    const occurredAt = new Date(deps.clock()).toISOString()
    return {
      provider,
      sessionId,
      kind,
      providerRecordKey,
      turnRef,
      sequence: nextSequence(sessionId),
      occurredAt,
      capturedAt: occurredAt,
      orgId,
      hostId,
      ...(toolName ? { toolName } : {}),
      ...(toolCallRef ? { toolCallRef } : {})
    }
  }

  const ingest = (payload: AgentHookEventPayload): void => {
    const event = toNormalized(payload)
    if (!event) {
      return
    }
    buffer.push(event)
    // Bounded ring: drop the oldest so a stalled scan cycle can't grow the buffer without bound.
    if (buffer.length > ringSize) {
      buffer.splice(0, buffer.length - ringSize)
    }
  }

  return {
    start: (subscribe) => {
      if (unsubscribe) {
        return
      }
      unsubscribe = subscribe(ingest)
    },
    ingest,
    drain: () => buffer.splice(0, buffer.length),
    stop: () => {
      unsubscribe?.()
      unsubscribe = null
      buffer.length = 0
    }
  }
}
