import type { AgentTranscriptRecordType } from './agent-transcript-record'

// Viewer visibility policy. A shared agent session projects DIFFERENT views: the
// driver (owner) sees the full transcript, while a viewer sees a filtered,
// redacted projection. This module decides, per record type, whether a viewer may
// see the record at all and whether it must be redacted first.
//
// A ViewerPolicy is an injected pure function so the caller can supply a custom
// policy (e.g. per-viewer capability) without this module owning any state.

export type ViewerVisibility = 'visible' | 'redact' | 'hidden'

export type ViewerPolicy = (recordType: AgentTranscriptRecordType) => ViewerVisibility

// Default viewer projection. Conservative by design: internal/system records are
// hidden, and every content-bearing type a viewer CAN see is redacted first —
// prompts and tool args can carry pasted secrets, and tool_output routinely
// echoes credentials, so redaction is the safe default rather than the exception.
const DEFAULT_VIEWER_VISIBILITY: Record<AgentTranscriptRecordType, ViewerVisibility> = {
  system: 'hidden',
  user_prompt: 'redact',
  assistant_msg: 'redact',
  tool_call: 'redact',
  tool_output: 'redact'
}

export const defaultViewerPolicy: ViewerPolicy = (recordType) =>
  DEFAULT_VIEWER_VISIBILITY[recordType] ?? 'hidden'

// The driver/owner projection: the full transcript, unfiltered and unredacted.
export const driverPolicy: ViewerPolicy = () => 'visible'
