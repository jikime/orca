import type { AgentEventEnvelope } from '../../shared/agent-event-batch-contract'
import { composeAgentEventEnvelope, hookEventId, turnKeyOf } from './agent-reconcile-envelope'
import type { HookEventKind, NormalizedHookEvent } from './agent-reconcile-types'

const HOOK_EVENT_TYPE: Record<HookEventKind, string> = {
  user_prompt: 'ai.pielab.agent.turn.prompt.v1',
  pre_tool: 'ai.pielab.agent.tool.started.v1',
  post_tool: 'ai.pielab.agent.tool.completed.v1',
  stop: 'ai.pielab.agent.turn.stopped.v1'
}

// Pure mapper: a normalized managed-hook payload → the s2 AgentEvent envelope. `source:'hook'`
// (via producer.type), `assertion:'observed'`. The eventId is content-derived and STABLE across a
// replay; the payload carries identifiers/hashes only — never the prompt or tool input.
export function hookEventEnvelope(event: NormalizedHookEvent): AgentEventEnvelope {
  const turnKey = turnKeyOf(event.provider, event.sessionId, event.turnRef)
  const eventId = hookEventId({
    provider: event.provider,
    sessionId: event.sessionId,
    kind: event.kind,
    providerRecordKey: event.providerRecordKey,
    toolCallRef: event.toolCallRef
  })

  return composeAgentEventEnvelope({
    eventId,
    producerType: 'hook',
    provider: event.provider,
    sessionId: event.sessionId,
    turnKey,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    capturedAt: event.capturedAt,
    orgId: event.orgId,
    hostId: event.hostId,
    type: HOOK_EVENT_TYPE[event.kind],
    payload: {
      sourceKind: 'hook',
      kind: event.kind,
      turnKey,
      turnRef: event.turnRef,
      providerRecordKey: event.providerRecordKey,
      sequence: event.sequence,
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(event.toolCallRef ? { toolCallRef: event.toolCallRef } : {})
    }
  })
}
