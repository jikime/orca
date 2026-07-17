import { DEFAULT_RELAY_LIMITS, type RelayLimits } from './relay-runtime-deps'

export type RelayConfig = {
  host: string
  port: number
  serviceName: string
  limits: RelayLimits
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

// All thresholds have sane defaults so the relay boots with zero config; each is
// overridable via env for load tuning.
export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    host: env.PIE_RELAY_HOST ?? '0.0.0.0',
    port: intFromEnv(env.PIE_RELAY_PORT, 8081),
    serviceName: 'relay',
    limits: {
      maxFrameBytes: intFromEnv(env.PIE_RELAY_MAX_FRAME_BYTES, DEFAULT_RELAY_LIMITS.maxFrameBytes),
      maxFramesPerSecond: intFromEnv(
        env.PIE_RELAY_MAX_FRAMES_PER_SECOND,
        DEFAULT_RELAY_LIMITS.maxFramesPerSecond
      ),
      maxBytesPerSecond: intFromEnv(
        env.PIE_RELAY_MAX_BYTES_PER_SECOND,
        DEFAULT_RELAY_LIMITS.maxBytesPerSecond
      ),
      maxQueuedPtyFrames: intFromEnv(
        env.PIE_RELAY_MAX_QUEUED_PTY_FRAMES,
        DEFAULT_RELAY_LIMITS.maxQueuedPtyFrames
      ),
      maxQueuedControlFrames: intFromEnv(
        env.PIE_RELAY_MAX_QUEUED_CONTROL_FRAMES,
        DEFAULT_RELAY_LIMITS.maxQueuedControlFrames
      ),
      sendHighWaterMarkBytes: intFromEnv(
        env.PIE_RELAY_SEND_HIGH_WATER_MARK_BYTES,
        DEFAULT_RELAY_LIMITS.sendHighWaterMarkBytes
      )
    }
  }
}
