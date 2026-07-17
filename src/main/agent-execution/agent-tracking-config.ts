import { join } from 'node:path'

// R5 s2/s2b/s3 composition dev-gate. Mirrors pie-realtime/realtime-config: the whole
// agent-execution-tracking subsystem is a strict no-op unless PIE_AGENT_TRACKING=1. There is NO
// production auto-start — this stays a dev-gated capability until an integration/QA slice promotes it.

export type PieAgentTrackingConfig = {
  enabled: boolean
  pumpIntervalMs: number
  scanIntervalMs: number
  contextTtlMs: number
}

const DEFAULT_PUMP_INTERVAL_MS = 5_000
const DEFAULT_SCAN_INTERVAL_MS = 15_000
// ExecutionContext validity window; short enough that a stale binding is refused, long enough that a
// steady pump does not re-sign every cycle (the pump refreshes before expiry, doc 24 anti-forgery).
const DEFAULT_CONTEXT_TTL_MS = 5 * 60_000

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim())
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function loadPieAgentTrackingConfig(
  env: NodeJS.ProcessEnv = process.env
): PieAgentTrackingConfig {
  return {
    // Explicit opt-in only: absent/any-other value → disabled, so normal Orca use is unaffected.
    enabled: env.PIE_AGENT_TRACKING?.trim() === '1',
    pumpIntervalMs: positiveIntEnv(env.PIE_AGENT_TRACKING_PUMP_MS, DEFAULT_PUMP_INTERVAL_MS),
    scanIntervalMs: positiveIntEnv(env.PIE_AGENT_TRACKING_SCAN_MS, DEFAULT_SCAN_INTERVAL_MS),
    contextTtlMs: positiveIntEnv(env.PIE_AGENT_TRACKING_CONTEXT_TTL_MS, DEFAULT_CONTEXT_TTL_MS)
  }
}

// The durable outbox lives on the client that holds the token (SSH-safe). Path is derived from the
// per-profile user-data dir via path.join so it is correct on macOS/Linux/Windows (no `/` assumption).
const OUTBOX_SUBDIR = ['pie', 'agent-outbox'] as const
const OUTBOX_FILE = 'agent-events.db'

export function resolveAgentOutboxPath(userDataPath: string): string {
  return join(userDataPath, ...OUTBOX_SUBDIR, OUTBOX_FILE)
}
