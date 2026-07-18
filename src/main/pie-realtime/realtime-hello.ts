import { PIE_REALTIME_PROTOCOL_VERSION } from '../../shared/pie-realtime-contract'

// The client.hello frame the connection sends on socket open: identifies the
// instance/org and replays from the last applied cursor. Optional capabilities
// ride along only when present so an older server never sees an unknown field.
export function buildClientHello(
  options: { instanceId: string; organizationId: string; capabilities?: readonly string[] },
  lastCursor: string | null
): Record<string, unknown> {
  return {
    type: 'client.hello',
    schemaVersion: 1,
    protocolVersion: PIE_REALTIME_PROTOCOL_VERSION,
    instanceId: options.instanceId,
    organizationId: options.organizationId,
    lastCursor,
    ...(options.capabilities ? { capabilities: options.capabilities } : {})
  }
}
