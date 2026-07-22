import type { ColumnType, Generated } from 'kysely'

// pg returns bigint (int8) as string; accept string/number/bigint on write.
type BigIntColumn = ColumnType<string, string | number | bigint, string | number | bigint>
type DefaultedBigIntColumn = ColumnType<
  string,
  string | number | bigint | undefined,
  string | number | bigint
>
type NullableBigIntColumn = ColumnType<
  string | null,
  string | number | bigint | null | undefined,
  string | number | bigint | null
>
type TimestampColumn = ColumnType<Date, Date | string | undefined, Date | string>
type NullableTimestampColumn = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>
// jsonb: read back as parsed JSON (unknown), written as a JSON string.
type JsonbColumn = ColumnType<unknown, string, string>
type NullableJsonbColumn = ColumnType<unknown, string | null | undefined, string | null>

export interface OrganizationsTable {
  id: string
  slug: string
  display_name: string
  status: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface UserAccountsTable {
  id: Generated<string>
  issuer: string
  subject: string
  email: string
  email_verified: Generated<boolean>
  display_name: string
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MembershipsTable {
  id: Generated<string>
  organization_id: string
  user_id: string
  status: Generated<string>
  role_ids: ColumnType<string[], string[] | undefined, string[]>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface InvitationsTable {
  id: Generated<string>
  organization_id: string
  email: string
  user_type: string
  role_ids: ColumnType<string[], string[] | undefined, string[]>
  customer_scope: string | null
  project_scope: string | null
  token_hash: string
  status: Generated<string>
  expires_at: TimestampColumn
  accepted_at: NullableTimestampColumn
  accepted_by: string | null
  created_by: string | null
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface DeviceSessionsTable {
  id: Generated<string>
  session_id: string
  family_id: Generated<string>
  user_id: string
  issuer: string
  subject: string
  status: Generated<string>
  rotation_counter: Generated<number>
  revoked_reason: string | null
  created_at: TimestampColumn
  last_seen_at: TimestampColumn
  revoked_at: NullableTimestampColumn
}

export interface RolesTable {
  id: string
  scope: string
  external: Generated<boolean>
}

export interface PermissionsTable {
  id: string
  resource: string
  action: string
  risk: string
}

export interface RolePermissionsTable {
  role_id: string
  permission_id: string
}

export interface RoleManifestSeedTable {
  id: Generated<boolean>
  checksum: string
  seeded_at: TimestampColumn
}

export interface EntitlementPlansTable {
  id: string
}

export interface PlanEntitlementsTable {
  plan_id: string
  entitlement_id: string
  enforcement: string
  limit_value: NullableBigIntColumn
  boolean_value: boolean | null
}

export interface EntitlementManifestSeedTable {
  id: Generated<boolean>
  checksum: string
  seeded_at: TimestampColumn
}

export interface SubscriptionsTable {
  organization_id: string
  plan_id: string
  deployment_type: Generated<string>
  status: Generated<string>
  current_period_start: TimestampColumn
  current_period_end: NullableTimestampColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface UsageMetersTable {
  organization_id: string
  entitlement_id: string
  current_value: DefaultedBigIntColumn
  updated_at: TimestampColumn
}

export interface ResourceGrantsTable {
  id: Generated<string>
  organization_id: string
  user_id: string
  resource_type: string
  resource_id: string
  grant_kind: string
  permission: string
  created_at: TimestampColumn
}

export interface OutboxEventsTable {
  id: string
  organization_id: string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: BigIntColumn
  event_type: string
  event_schema_version: number
  payload: JsonbColumn
  occurred_at: TimestampColumn
  available_at: TimestampColumn
  claimed_by: string | null
  claim_expires_at: NullableTimestampColumn
  attempt_count: Generated<number>
  published_at: NullableTimestampColumn
  last_error_code: string | null
  stream_sequence: NullableBigIntColumn
  parked_at: NullableTimestampColumn
}

export interface DeadLetterEventsTable {
  id: string
  organization_id: string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: BigIntColumn
  event_type: string
  event_schema_version: number
  payload: JsonbColumn
  occurred_at: TimestampColumn
  attempt_count: number
  last_error_code: string | null
  parked_at: TimestampColumn
  status: Generated<string>
  requeue_count: Generated<number>
  requeued_at: NullableTimestampColumn
  requeued_by: string | null
}

export interface StreamCursorsTable {
  organization_id: string
  last_sequence: DefaultedBigIntColumn
  updated_at: TimestampColumn
}

export interface OperationsTable {
  id: Generated<string>
  organization_id: string
  kind: string
  status: Generated<string>
  result_resource_id: string | null
  problem: NullableJsonbColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface IdempotencyRecordsTable {
  id: Generated<string>
  organization_id: string
  principal_id: string
  request_method: string
  request_route: string
  idempotency_key: string
  payload_hash: string
  status: Generated<string>
  response_ref: string | null
  lease_expires_at: NullableTimestampColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface AuditEventsTable {
  id: Generated<string>
  organization_id: string
  actor_id: string | null
  action: string
  target_type: string
  target_id: string | null
  before_digest: string | null
  after_digest: string | null
  request_id: string | null
  trace_id: string | null
  occurred_at: TimestampColumn
}

export interface AuthorizationDenialsTable {
  id: Generated<string>
  requested_organization_id: string | null
  actor_user_id: string | null
  issuer: string | null
  subject: string | null
  permission: string
  reason: string
  request_id: string | null
  occurred_at: TimestampColumn
}

export interface ObjectsTable {
  id: string
  organization_id: string
  storage_key: string
  sha256: string
  size_bytes: BigIntColumn
  content_type: string
  classification: string
  status: Generated<string>
  created_at: TimestampColumn
}

export interface ArtifactsTable {
  id: string
  organization_id: string
  project_id: string
  work_item_id: string | null
  name: string
  classification: string
  visibility: string
  status: Generated<string>
  current_revision: Generated<number>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface ArtifactRevisionsTable {
  id: string
  organization_id: string
  artifact_id: string
  revision: number
  object_id: string
  sha256: string
  size_bytes: BigIntColumn
  status: Generated<string>
  created_at: TimestampColumn
}

export interface ArtifactUploadSessionsTable {
  id: string
  organization_id: string
  artifact_id: string
  object_id: string
  storage_key: string
  sha256: string
  size_bytes: BigIntColumn
  content_type: string
  method: Generated<string>
  status: Generated<string>
  expires_at: TimestampColumn
  created_at: TimestampColumn
}

export interface TeamsTable {
  organization_id: string
  id: Generated<string>
  key: string
  name: string
  version: DefaultedBigIntColumn
  workflow_version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface WorkflowStatesTable {
  organization_id: string
  id: Generated<string>
  team_id: string
  key: string
  name: string
  category: string
  sort_key: BigIntColumn
  created_at: TimestampColumn
}

export interface WorkItemsTable {
  organization_id: string
  id: Generated<string>
  team_id: string
  project_id: string | null
  sequence: BigIntColumn
  identifier: string
  title: string
  description: string | null
  state_id: string
  workflow_version: BigIntColumn
  assignee_id: string | null
  creator_id: string
  priority: Generated<string>
  sort_key: BigIntColumn
  version: DefaultedBigIntColumn
  archived_at: NullableTimestampColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface TeamCountersTable {
  organization_id: string
  team_id: string
  next_sequence: DefaultedBigIntColumn
}

export interface CommentsTable {
  organization_id: string
  id: Generated<string>
  work_item_id: string
  author_id: string
  body: string
  visibility: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface ProjectsTable {
  organization_id: string
  id: Generated<string>
  name: string
  summary: string | null
  status: Generated<string>
  // R5 s5a: the project-level capture-mode default a new agent session inherits.
  default_capture_mode: Generated<string>
  version: DefaultedBigIntColumn
  archived_at: NullableTimestampColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface ProjectTeamsTable {
  organization_id: string
  project_id: string
  team_id: string
  created_at: TimestampColumn
}

export interface ChannelsTable {
  organization_id: string
  id: Generated<string>
  name: string
  kind: Generated<string>
  scope_type: Generated<string>
  scope_id: string | null
  visibility: Generated<string>
  dm_key: string | null
  topic: Generated<string>
  description: Generated<string>
  retention_days: number | null
  version: DefaultedBigIntColumn
  archived_at: NullableTimestampColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface ChannelMembersTable {
  organization_id: string
  channel_id: string
  user_id: string
  role: Generated<string>
  added_at: TimestampColumn
}

export interface MessagesTable {
  organization_id: string
  id: Generated<string>
  channel_id: string
  author_user_id: string
  body: string
  visibility: Generated<string>
  version: DefaultedBigIntColumn
  thread_root_message_id: string | null
  // Soft-delete tombstone (doc 33 §2): deleted_at present == redacted; deleted_by /
  // deletion_reason are the retained audit metadata. All nullable (live message = null).
  deleted_at: NullableTimestampColumn
  deleted_by: string | null
  deletion_reason: string | null
  created_at: TimestampColumn
  updated_at: TimestampColumn
  // STORED generated tsvector (slice 7 search). Never selected/inserted via the query
  // builder — matched only through a raw `search_tsv @@ ...` predicate — so it is typed
  // never-selectable/never-writable to keep it out of insert and selectAll shapes.
  search_tsv: ColumnType<never, never, never>
}

// Immutable body snapshot per committed revision (doc 33 §1). revision == the
// messages.version the body was live under; delete redacts body but keeps the row.
export interface MessageRevisionsTable {
  organization_id: string
  id: Generated<string>
  message_id: string
  revision: BigIntColumn
  body: string
  edited_by: string
  created_at: TimestampColumn
}

export interface MessageReactionsTable {
  organization_id: string
  message_id: string
  user_id: string
  emoji: string
  created_at: TimestampColumn
}

export interface ReadCursorsTable {
  organization_id: string
  channel_id: string
  user_id: string
  last_read_message_id: string | null
  last_read_at: TimestampColumn
}

export interface MessageMentionsTable {
  organization_id: string
  message_id: string
  mentioned_user_id: string
  created_at: TimestampColumn
}

export interface MessageAttachmentsTable {
  organization_id: string
  id: Generated<string>
  channel_id: string
  message_id: string | null
  object_id: string
  storage_key: string
  filename: string
  content_type: string
  byte_size: BigIntColumn
  status: Generated<string>
  created_at: TimestampColumn
}

export interface NotificationsTable {
  organization_id: string
  id: Generated<string>
  user_id: string
  type: string
  channel_id: string | null
  message_id: string | null
  seen: Generated<boolean>
  read: Generated<boolean>
  created_at: TimestampColumn
}

export interface ChannelMutesTable {
  organization_id: string
  channel_id: string
  user_id: string
  created_at: TimestampColumn
}

export interface NotificationPreferencesTable {
  organization_id: string
  user_id: string
  desktop_enabled: Generated<boolean>
  dnd_enabled: Generated<boolean>
  dnd_start_minute: Generated<number>
  dnd_end_minute: Generated<number>
  timezone: Generated<string>
  updated_at: TimestampColumn
}

export interface ChannelNotificationPreferencesTable {
  organization_id: string
  channel_id: string
  user_id: string
  level: string
  updated_at: TimestampColumn
}

// A pinned message (doc 33 §3). One row per pinned (channel, message); pinned_by is the
// actor. Cascades away with its channel OR its message (a deleted message's pin is gone).
export interface MessagePinsTable {
  organization_id: string
  id: Generated<string>
  channel_id: string
  message_id: string
  pinned_by: string
  created_at: TimestampColumn
}

// A message→WorkItem conversion link (doc 33 §4). One row = a chat message was turned into a
// delivery work item. work_item_id has NO cross-schema FK — collaboration must not hard-depend
// on delivery's layout; the same-org invariant is enforced in code (one org tenant tx).
export interface MessageWorkItemLinksTable {
  organization_id: string
  id: Generated<string>
  message_id: string
  work_item_id: string
  created_by: string
  created_at: TimestampColumn
}

// RemoteSession control-plane authority (R8 slice A1, doc 34 Phase A / doc 07). status is the
// doc 07 state machine; the legal-transition table is enforced in the store (a CHECK cannot see
// the prior value). ticket_id is a nullable forward pointer with NO cross-schema FK yet.
export interface RemoteSessionsTable {
  organization_id: string
  id: Generated<string>
  kind: string
  status: Generated<string>
  host_user_id: string
  created_by: string
  ticket_id: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// A roster row (doc 07 권한 등급, ascending). is_driver marks the single operator; left_at set
// means the participant left (the active-roster unique index excludes left rows).
export interface RemoteSessionParticipantsTable {
  organization_id: string
  id: Generated<string>
  session_id: string
  user_id: string
  grade: string
  is_driver: Generated<boolean>
  joined_at: TimestampColumn
  left_at: NullableTimestampColumn
}

// The customer's recorded consent (doc 07). Revocation sets revoked_at; a consent row is never
// hard-deleted (audit). Cascades with its session.
export interface RemoteSessionConsentsTable {
  organization_id: string
  id: Generated<string>
  session_id: string
  subject_user_id: string
  scope: Generated<string>
  granted_at: TimestampColumn
  revoked_at: NullableTimestampColumn
}

// A scoped short-lived single-use capability token (R8 slice A2, doc 34 §데이터모델 / §보안 제약
// #3). Bound to one session + one participant, audience-restricted, single-use via nonce, and
// expiring. consumed_at/revoked_at are the redemption/invalidation tombstones.
export interface RemoteSessionCapabilitiesTable {
  organization_id: string
  id: Generated<string>
  session_id: string
  participant_id: string
  capability: string
  audience: string
  nonce: string
  expires_at: TimestampColumn
  consumed_at: NullableTimestampColumn
  revoked_at: NullableTimestampColumn
  requires_step_up: Generated<boolean>
  issued_by: string
  created_at: TimestampColumn
}

// A driver-change history/audit row (R8 slice A3, doc 34 §슬라이스 A3 / §보안 제약 #2). The CURRENT
// driver is denormalized on RemoteSessionParticipantsTable.is_driver; this table records every
// grant (a handoff revokes the prior, a revoke stamps revoked_at). A partial unique index enforces
// at most one active (revoked_at is null) grant per session. approver_user_id must differ from the
// operator's user (approver≠operator) — enforced in the store.
export interface RemoteSessionDriverGrantsTable {
  organization_id: string
  id: Generated<string>
  session_id: string
  operator_participant_id: string
  approver_user_id: string
  capability_id: string | null
  granted_at: TimestampColumn
  revoked_at: NullableTimestampColumn
  revoke_reason: string | null
}

// FK-free best-effort audit stream (mirrors audit.authorization_denials). No session FK so an
// audit write can never fail the main mutation tx.
export interface RemoteSessionAuditTable {
  organization_id: string
  id: Generated<string>
  session_id: string
  event_type: string
  actor_user_id: string | null
  detail: JsonbColumn
  created_at: TimestampColumn
}

// R5 s1: one AI agent session (Claude Code / Codex). work_item_id is an opaque forward
// link (no FK). status gates ingest — a closed/terminated session accepts no more events.
export interface AgentSessionsTable {
  organization_id: string
  id: Generated<string>
  work_item_id: string | null
  provider: string
  provider_session_id: string | null
  host_id: string
  launch_id: string | null
  status: Generated<string>
  visibility: string
  classification: string
  // R5 s5a: full | metadata_only | paused — the ingest capture policy for this session.
  capture_mode: Generated<string>
  created_by: string
  version: DefaultedBigIntColumn
  // R5 s2b: the SIGNED SessionBinding. binding_trust_domain defaults to 'local_observed' (identity-
  // only ingest); a verified signed ExecutionContext promotes it to 'installation_signed' and stamps
  // the host identity (native/wsl/ssh) + workspace + expiry. All binding_* are null until then.
  binding_trust_domain: Generated<string>
  binding_installation_id: string | null
  binding_host_type: string | null
  binding_host_id: string | null
  binding_workspace_path: string | null
  // R5 audit: osUser-disambiguates-shared-host (IDN-008) + provider-in-binding (BND-002). Part of the
  // binding identity tuple compared for BINDING_HOST_MISMATCH; null on pre-audit / identity-only rows.
  binding_os_user: string | null
  binding_provider: string | null
  binding_not_after: NullableTimestampColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// R5 s2b: the per-installation Ed25519 PUBLIC key registry (doc 24 anti-forgery). One row per
// (org, user, installation); a re-register rotates the row in place (rotation_count bumps).
// public_key is the SPKI PEM; public_key_id is base64url(sha256(SPKI DER)) — the rotation-
// detectable fingerprint. pie_app gets INSERT + SELECT + UPDATE (upsert rotation).
export interface InstallationPublicKeysTable {
  organization_id: string
  id: Generated<string>
  user_id: string
  installation_id: string
  public_key: string
  public_key_id: string
  algorithm: Generated<string>
  registered_at: TimestampColumn
  updated_at: TimestampColumn
  rotation_count: Generated<number>
}

// R5 s5 batch anti-replay: one row per consumed (org, installation, submission_nonce). A second
// consumption of the same nonce under a DIFFERENT batch_id is a replay; the SAME batch_id is a
// legit retry. not_after (the signed context's expiry) bounds a prune-on-write. INSERT/SELECT/DELETE.
export interface BatchSubmissionNoncesTable {
  organization_id: string
  installation_id: string
  submission_nonce: string
  batch_id: string
  consumed_at: TimestampColumn
  not_after: TimestampColumn
}

// The append-only envelope log (doc 19 :203). event_id is the per-org idempotency key.
// stream_id + sequence is for gap detection; occurred/captured/received are kept distinct.
// pie_app gets INSERT + SELECT only — never UPDATE/DELETE (append-only).
export interface AgentEventsTable {
  organization_id: string
  id: Generated<string>
  event_id: string
  agent_session_id: string
  schema_version: Generated<number>
  stream_id: string
  sequence: BigIntColumn
  type: string
  source_uri: string
  subject: string
  producer_id: string
  producer_type: string
  provider: string
  parser_version: string
  trust_domain: string
  assertion: string
  classification: string
  visibility: string
  agent_run_id: string | null
  turn_id: string | null
  subagent_id: string | null
  occurred_at: TimestampColumn
  captured_at: TimestampColumn
  received_at: TimestampColumn
  content_hash: string | null
  payload: NullableJsonbColumn
  payload_object: NullableJsonbColumn
  correlation_id: string | null
  causation_id: string | null
  created_at: TimestampColumn
}

// The projected timeline (doc 19 :235-236). A streaming event makes/updates a provisional
// turn; a confirmed content_hash from an observed/verified event finalizes it (immutable).
export interface AgentTurnsTable {
  organization_id: string
  id: Generated<string>
  agent_session_id: string
  turn_id: string
  status: Generated<string>
  content_hash: string | null
  first_sequence: BigIntColumn
  last_sequence: BigIntColumn
  first_stream_id: string
  revision: Generated<number>
  event_count: Generated<number>
  first_event_at: TimestampColumn
  last_event_at: TimestampColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// The queryable provenance projection (doc 19 :265-271, R5 s4a). One row is derived from
// exactly one append-only agent_events row (source_event_id). trust_domain keeps `declared`
// claims separate from `local_observed`/`server_verified` evidence; pie_app gets INSERT +
// SELECT only (immutable evidence — a correction is a new revision row).
export interface AgentProvenanceTable {
  organization_id: string
  id: Generated<string>
  source_event_id: string
  agent_session_id: string
  agent_run_id: string | null
  kind: string
  trust_domain: string
  provider: string | null
  repository: string | null
  source_revision: string | null
  commit_sha: string | null
  change_request_ref: string | null
  change_request_url: string | null
  change_request_state: string | null
  source_branch: string | null
  target_branch: string | null
  command: string | null
  exec_environment: string | null
  exit_code: number | null
  result_parser_version: string | null
  file_path: string | null
  change_type: string | null
  artifact_id: string | null
  content_hash: string | null
  work_item_id: string | null
  revision: Generated<number>
  corrects_provenance_id: string | null
  occurred_at: TimestampColumn
  received_at: TimestampColumn
  created_at: TimestampColumn
}

// R5 s5a: an append-only capture-gap tombstone. A session in capture_mode='paused' drops the
// event but writes one of these so a paused window shows an EXPLICIT gap on the timeline, never a
// silent false-complete. Carries the dropped event's visibility so the per-scope read filter hides
// an internal-only gap from a customer-scoped reader. pie_app gets INSERT + SELECT only.
export interface AgentCaptureGapsTable {
  organization_id: string
  id: Generated<string>
  event_id: string
  agent_session_id: string
  stream_id: string
  sequence: BigIntColumn
  turn_id: string | null
  visibility: string
  reason: Generated<string>
  occurred_at: TimestampColumn
  captured_at: TimestampColumn
  received_at: TimestampColumn
  created_at: TimestampColumn
}

// The unassigned-session intake queue (doc 19 :162, doc 24 CAP-001, R5 s4b). One MUTABLE row per
// session that exists without a work_item binding; a human explicitly assigns it (which sets the
// session's work_item_id) — a session is never auto-attached to a project. pie_app gets INSERT +
// SELECT + UPDATE (the queue transitions pending → assigned/dismissed); the trail is in audit.
export interface AgentSessionIntakeTable {
  organization_id: string
  id: Generated<string>
  agent_session_id: string
  source_type: Generated<string>
  status: Generated<string>
  detected_reason: Generated<string>
  host_id: string
  workspace_id: string | null
  provider: string
  work_item_id: string | null
  assigned_by: string | null
  assigned_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// OPS-001 poison-event quarantine (dead-letter). One row per per-item-rejected agent event, so a
// poison is durably visible to operators, not just a transient batch status. METADATA ONLY: the
// raw poison body is never stored (content_hash + payload_size_bytes stand in for it). FK-free
// (the rejected event is never inserted, its session may not exist). pie_app gets INSERT + SELECT
// (write on rejection, read the queue) + UPDATE (operator discard/recover); trail lives in audit.
export interface AgentEventQuarantineTable {
  organization_id: string
  id: Generated<string>
  event_id: string
  agent_session_id: string
  stream_id: string
  sequence: BigIntColumn
  reason_code: string
  content_hash: string | null
  payload_size_bytes: number
  status: Generated<string>
  resolved_by: string | null
  resolved_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  quarantined_at: TimestampColumn
  updated_at: TimestampColumn
}

// pg returns numeric(18,2) as a string; accept string/number on write.
type NumericColumn = ColumnType<string, string | number | undefined, string | number>
type NullableNumericColumn = ColumnType<
  string | null,
  string | number | null | undefined,
  string | number | null
>
type NullableDateColumn = ColumnType<string | null, string | null | undefined, string | null>
type DateColumn = ColumnType<string, string, string>

// === R6 CRM / contract tables (20260819090001) ===
export interface CrmAccountsTable {
  organization_id: string
  id: Generated<string>
  name: string
  status: Generated<string>
  owner_user_id: string | null
  external_ref: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface CrmAccountSitesTable {
  organization_id: string
  id: Generated<string>
  account_id: string
  name: string
  timezone: Generated<string>
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface CrmAccountContactsTable {
  organization_id: string
  id: Generated<string>
  account_id: string
  site_id: string | null
  name: string
  email: string | null
  role: string | null
  created_at: TimestampColumn
}

export interface CrmOpportunitiesTable {
  organization_id: string
  id: Generated<string>
  account_id: string
  name: string
  stage: Generated<string>
  amount: NumericColumn
  probability: number | null
  owner_user_id: string | null
  expected_close_at: NullableDateColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface CrmContractsTable {
  organization_id: string
  id: Generated<string>
  account_id: string
  title: string
  contract_value: NumericColumn
  approval_status: Generated<string>
  effective_start: NullableDateColumn
  effective_end: NullableDateColumn
  submitted_by: string | null
  approved_by: string | null
  approved_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface CrmContractScopeItemsTable {
  organization_id: string
  id: Generated<string>
  contract_id: string
  service_type: string
  description: string | null
  quantity: NumericColumn
  rate: NumericColumn
  sort_key: Generated<number>
  created_at: TimestampColumn
}

export interface CrmChangeOrdersTable {
  organization_id: string
  id: Generated<string>
  contract_id: string
  title: string
  approval_status: Generated<string>
  value_delta: NumericColumn
  submitted_by: string | null
  customer_approver_user_id: string | null
  approved_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface CrmChangeOrderScopeItemsTable {
  organization_id: string
  id: Generated<string>
  change_order_id: string
  change_kind: Generated<string>
  service_type: string
  description: string | null
  quantity: NumericColumn
  rate: NumericColumn
  sort_key: Generated<number>
  created_at: TimestampColumn
}

export interface CrmContractProjectsTable {
  organization_id: string
  id: Generated<string>
  contract_id: string
  project_id: string
  created_by: string | null
  created_at: TimestampColumn
}

// === R6 project-execution change requests (20260825090001) ===
// project_id / wbs_node_id / requirement_id are OPAQUE cross-schema links (no FK); version is the
// OCC counter. status is the pre-approval execution gate (draft→submitted→approved→applied).
export interface ChangeRequestsTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  wbs_node_id: string | null
  requirement_id: string | null
  title: string
  description: string | null
  status: Generated<string>
  scope_delta: string | null
  schedule_delta_days: number | null
  cost_delta: NullableNumericColumn
  requested_by: string | null
  approver_user_id: string | null
  decided_at: NullableTimestampColumn
  applied_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// === R6 s2 requirements + traceability tables (20260820090001) ===
// project_id / contract_scope_item_id are OPAQUE cross-schema links (no FK); version is the OCC counter.
export interface RequirementsTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  contract_scope_item_id: string | null
  code: string
  title: string
  description: string | null
  status: Generated<string>
  priority: Generated<string>
  source: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// work_item_id is an OPAQUE id into delivery.work_items (no cross-schema FK).
export interface RequirementWorkItemsTable {
  organization_id: string
  id: Generated<string>
  requirement_id: string
  work_item_id: string
  created_by: string | null
  created_at: TimestampColumn
}

// === R6 qa: deliverables + test cases + defects (20260826090001) ===
// project_id / requirement_id / wbs_node_id / work_item_id / test_case_id / deliverable_id are OPAQUE
// cross-schema links (no FK). status is the OCC :transition target; version is the OCC counter.
export interface DeliverablesTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  requirement_id: string | null
  wbs_node_id: string | null
  name: string
  description: string | null
  status: Generated<string>
  due_date: NullableDateColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface TestCasesTable {
  organization_id: string
  id: Generated<string>
  requirement_id: string | null
  work_item_id: string | null
  title: string
  steps: string | null
  expected: string | null
  status: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface DefectsTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  test_case_id: string | null
  work_item_id: string | null
  deliverable_id: string | null
  title: string
  description: string | null
  severity: Generated<string>
  status: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// === R6 governance tables (20260827090001) ===
// project_id / owner_user_id are OPAQUE cross-schema links (no FK). severity is DERIVED from
// probability × impact and stored (computed on write). version is OCC.
export interface ProjectRisksTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  title: string
  description: string | null
  category: Generated<string>
  probability: Generated<string>
  impact: Generated<string>
  severity: Generated<string>
  status: Generated<string>
  mitigation: string | null
  owner_user_id: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// Append-oriented decision log: supersedes_id / related_risk_id / decided_by are OPAQUE same-tenant
// links (no FK). A superseding decision is a NEW row referencing the prior via supersedes_id.
export interface ProjectDecisionsTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  title: string
  context: string | null
  decision: string
  rationale: string | null
  decided_by: string | null
  decided_at: TimestampColumn
  related_risk_id: string | null
  supersedes_id: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// Periodic status report: overall_status is green|amber|red over [period_start, period_end].
// project_id / reported_by are OPAQUE links (no FK). version is OCC.
export interface StatusReportsTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  period_start: DateColumn
  period_end: DateColumn
  overall_status: Generated<string>
  summary: string
  highlights: string | null
  risks_summary: string | null
  next_steps: string | null
  reported_by: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// === R7 knowledge base + permission-aware search table (20260828090001) ===
// source_id (the ticket / remote-session an article was distilled from) and project_id (an optional
// scope) are OPAQUE cross-schema links (no FK). review_status + reviewed_by/reviewed_at is the human
// review record that gates AI-authored publish. version is OCC.
export interface KnowledgeArticlesTable {
  organization_id: string
  id: Generated<string>
  title: string
  body: string
  status: Generated<string>
  visibility: Generated<string>
  source_type: Generated<string>
  source_id: string | null
  review_status: Generated<string>
  reviewed_by: string | null
  reviewed_at: NullableTimestampColumn
  author_user_id: string
  project_id: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
  // STORED generated tsvector (search). Never selected/inserted via the query builder — matched only
  // through a raw `tsv @@ ...` predicate — so it is typed never-selectable/never-writable.
  tsv: ColumnType<never, never, never>
}

// === R7 automation: approval-gated runbooks + work queue (20260829090001) ===
// A runbook DEFINITION. steps is an ordered jsonb step list opaque to the control plane.
// requires_approval defaults true so an execution is inert until approved. version is OCC.
export interface AutomationRunbooksTable {
  organization_id: string
  id: Generated<string>
  name: string
  description: string | null
  steps: JsonbColumn
  target_kind: string
  requires_approval: Generated<boolean>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// A single RUN of a runbook. runbook_id / target_id / rollback_of_execution_id are OPAQUE ids (no
// FK). status is the pre-run approval gate: an unapproved :run is refused. approver_user_id +
// approved_at record the AUDITED approval; result the AUDITED outcome; rollback_of_execution_id the
// AUDITED compensating run (rollback-is-new-execution). version is OCC.
export interface RunbookExecutionsTable {
  organization_id: string
  id: Generated<string>
  runbook_id: string
  target_id: string
  target_kind: string
  status: Generated<string>
  requested_by: string | null
  approver_user_id: string | null
  approved_at: NullableTimestampColumn
  result: NullableJsonbColumn
  rollback_of_execution_id: string | null
  started_at: NullableTimestampColumn
  finished_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// A unit of work in the operator queue. subject_id is the OPAQUE id of what it tracks (no FK).
// assignee_user_id is set on :claim. status/priority are checked vocabularies. version is OCC.
export interface WorkQueueItemsTable {
  organization_id: string
  id: Generated<string>
  title: string
  description: string | null
  kind: string
  subject_id: string | null
  status: Generated<string>
  assignee_user_id: string | null
  priority: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// === R7 meetings: signaling/metadata/consent/recording-ref/transcript/minutes (20260831090001) ===
// A meeting (media transport is infra). scope_kind/scope_id are the OPAQUE project/ticket context the
// result is preserved in. status walks scheduled → live → ended (or cancelled). version is OCC.
export interface MeetingsTable {
  organization_id: string
  id: Generated<string>
  title: string
  scope_kind: Generated<string>
  scope_id: string | null
  host_user_id: string
  scheduled_start: NullableTimestampColumn
  scheduled_end: NullableTimestampColumn
  time_zone: Generated<string>
  recurrence: Generated<string>
  series_id: string | null
  occurrence_index: Generated<number>
  status: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MeetingCalendarLinksTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  provider: string
  calendar_id: string
  event_id: string | null
  web_url: string | null
  sync_status: Generated<string>
  last_error: string | null
  last_synced_at: NullableTimestampColumn
  created_by: string
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MeetingGuestLinksTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  token_hash: string
  identity_mode: string
  visibility: string
  expires_at: TimestampColumn
  revoked_at: NullableTimestampColumn
  revoked_by: string | null
  created_by: string
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MeetingGuestSessionsTable {
  organization_id: string
  id: Generated<string>
  guest_link_id: string
  meeting_id: string
  user_id: string
  display_name: string
  email: string | null
  access_token_hash: string
  expires_at: TimestampColumn
  revoked_at: NullableTimestampColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// A member's presence + recording consent in a meeting. meeting_id is OPAQUE (no FK). consent_recording
// is the 녹화 동의 the recording gate consults. version is OCC.
export interface MeetingParticipantsTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  user_id: string
  role: Generated<string>
  access_status: Generated<string>
  consent_recording: Generated<boolean>
  joined_at: NullableTimestampColumn
  left_at: NullableTimestampColumn
  presence_observed_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// Signed LiveKit delivery ids make participant presence replay-safe and retain the media-plane
// observation that drove each control-plane update.
export interface MeetingMediaEventsTable {
  organization_id: string
  event_id: string
  meeting_id: string
  event_type: string
  occurred_at: TimestampColumn
  received_at: TimestampColumn
}

// A recording reference (the media upload is infra). object_ref is the OPAQUE storage object id set at
// :finalize; status walks pending → available (or failed). version is OCC.
export interface MeetingRecordingsTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  object_ref: string | null
  status: Generated<string>
  duration_seconds: number | null
  started_at: TimestampColumn
  video_egress_id: string | null
  audio_egress_id: string | null
  transcription_dispatch_id: string | null
  stopped_at: NullableTimestampColumn
  error_code: string | null
  capture_types: ColumnType<string[], string[] | undefined, string[]>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MeetingGovernanceTable {
  organization_id: string
  meeting_id: string
  policy_version: DefaultedBigIntColumn
  purpose: Generated<string>
  retention_days: number | null
  retention_until: NullableTimestampColumn
  legal_hold: Generated<boolean>
  capture_status: Generated<string>
  active_capture_types: ColumnType<string[], string[] | undefined, string[]>
  deletion_status: Generated<string>
  deletion_requested_at: NullableTimestampColumn
  deletion_requested_by: string | null
  deletion_reason: string | null
  deletion_completed_at: NullableTimestampColumn
  deletion_attempts: Generated<number>
  deletion_available_at: NullableTimestampColumn
  deletion_leased_until: NullableTimestampColumn
  deletion_worker_id: string | null
  deletion_last_error: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MeetingCaptureConsentsTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  participant_id: string
  capture_type: string
  policy_version: BigIntColumn
  purpose: string
  status: Generated<string>
  granted_at: NullableTimestampColumn
  revoked_at: NullableTimestampColumn
  expires_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// Leased post-processing work. The worker claims globally under pie_worker, then re-enters the
// tenant boundary to persist the transcript and review-gated AI minutes.
export interface MeetingProcessingJobsTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  recording_id: string
  job_type: string
  status: Generated<string>
  attempts: Generated<number>
  available_at: TimestampColumn
  leased_until: NullableTimestampColumn
  worker_id: string | null
  last_error: string | null
  transcript_id: string | null
  minutes_id: string | null
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// A caption/transcript. meeting_id is OPAQUE (no FK). content OR segments carries the text (at least
// one). source records provenance (live_caption | post_recording | ai). version is OCC.
export interface MeetingTranscriptsTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  content: string | null
  segments: NullableJsonbColumn
  source: string
  language: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MeetingTranscriptSegmentsTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  transcript_id: string
  sequence: number
  speaker_participant_id: string | null
  speaker_label: string
  start_ms: number
  end_ms: number
  text: string
  language: string | null
  confidence: number | null
  source: string
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MeetingTranscriptSegmentRevisionsTable {
  organization_id: string
  id: Generated<string>
  segment_id: string
  revision: BigIntColumn
  speaker_participant_id: string | null
  speaker_label: string
  text: string
  edited_by: string
  created_at: TimestampColumn
}

export interface MeetingDecisionsTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  minutes_id: string | null
  statement: string
  status: Generated<string>
  owner_user_id: string | null
  project_id: string | null
  ticket_id: string | null
  evidence_segment_id: string | null
  created_by: string
  review_status: Generated<string>
  reviewed_by: string | null
  reviewed_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MeetingActionItemsTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  minutes_id: string | null
  task: string
  assignee_user_id: string | null
  assignee_label: string | null
  due_at: NullableTimestampColumn
  due_text: string | null
  priority: Generated<string>
  status: Generated<string>
  project_id: string | null
  ticket_id: string | null
  work_item_id: string | null
  evidence_segment_id: string | null
  created_by: string
  review_status: Generated<string>
  reviewed_by: string | null
  reviewed_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// AI/human meeting minutes. meeting_id is OPAQUE (no FK). source_type records provenance; review_status
// + reviewed_by + reviewed_at is the human review record. AI-authored minutes may not be finalized while
// unreviewed. status walks draft → finalized. version is OCC.
export interface MeetingMinutesTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  summary: string
  source_type: Generated<string>
  review_status: Generated<string>
  reviewed_by: string | null
  reviewed_at: NullableTimestampColumn
  status: Generated<string>
  author_user_id: string
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MeetingMinuteRevisionsTable {
  organization_id: string
  id: Generated<string>
  minutes_id: string
  revision: BigIntColumn
  summary: string
  edited_by: string
  created_at: TimestampColumn
}

export interface MeetingAgendaItemsTable {
  organization_id: string
  id: Generated<string>
  meeting_id: string
  source_channel_id: string
  source_message_id: string
  body: string
  status: Generated<string>
  created_by: string
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// === R8 asset registry / CMDB (20260901090001) ===
// A registry entry. account_id / project_id / assigned_to_user_id are OPAQUE cross-schema links (no FK).
// status walks active → in_repair → active|retired|lost (a status change is the OCC :transition;
// assignment is an OCC update). version is OCC.
export interface AssetsTable {
  organization_id: string
  id: Generated<string>
  name: string
  asset_type: Generated<string>
  status: Generated<string>
  account_id: string | null
  project_id: string | null
  assigned_to_user_id: string | null
  identifier: string | null
  vendor: string | null
  purchase_date: NullableDateColumn
  warranty_end: NullableDateColumn
  notes: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// The CMDB relationship graph. asset_id / linked_id are OPAQUE ids (no FK). A UNIQUE
// (organization_id, asset_id, linked_kind, linked_id, relation) makes a duplicate edge a constraint
// error. version present for wire uniformity.
export interface AssetLinksTable {
  organization_id: string
  id: Generated<string>
  asset_id: string
  linked_kind: string
  linked_id: string
  relation: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// The append-only lifecycle log — every asset mutation writes one row (never updated in place, so no
// version/OCC). asset_id / actor_user_id are OPAQUE ids (no FK). detail is opaque jsonb.
export interface AssetEventsTable {
  organization_id: string
  id: Generated<string>
  asset_id: string
  event_kind: string
  detail: NullableJsonbColumn
  actor_user_id: string | null
  occurred_at: TimestampColumn
}

// === R9 finance: invoices + line items + payments (20260902090001) ===
// A bill for a customer account. account_id / contract_id / project_id are OPAQUE cross-schema links
// (no FK). subtotal/total are recomputed from the line items (total = subtotal + tax_amount);
// amount_paid is drawn down by payments. status walks draft → issued → partially_paid → paid | void.
// invoice_number is unique per org. version is OCC.
export interface FinanceInvoicesTable {
  organization_id: string
  id: Generated<string>
  account_id: string
  contract_id: string | null
  project_id: string | null
  invoice_number: string
  status: Generated<string>
  currency: Generated<string>
  subtotal: NumericColumn
  tax_amount: NumericColumn
  total: NumericColumn
  amount_paid: NumericColumn
  issue_date: NullableDateColumn
  due_date: NullableDateColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// A billed line. invoice_id is a same-schema composite FK to the parent (never dangles/crosses
// tenants). amount = round(quantity * unit_price, 2), computed on write; a line change recomputes the
// parent invoice totals while draft.
export interface FinanceInvoiceLineItemsTable {
  organization_id: string
  id: Generated<string>
  invoice_id: string
  description: string
  quantity: NumericColumn
  unit_price: NumericColumn
  amount: NumericColumn
  sort_order: Generated<number>
  created_at: TimestampColumn
}

// An append-only payment receipt. invoice_id is a same-schema composite FK. Recording a payment
// atomically increments the parent invoice amount_paid under a row lock; recorded_by is OPAQUE.
export interface FinancePaymentsTable {
  organization_id: string
  id: Generated<string>
  invoice_id: string
  amount: NumericColumn
  paid_at: TimestampColumn
  method: Generated<string>
  reference: string | null
  recorded_by: string | null
  created_at: TimestampColumn
}

// === R7 ai governance: entitlements + quota + evaluation + guard log (20260830090001) ===
// What an org MAY use. resource_kind is model|tool, resource_key the OPAQUE resource key. allowed gates
// access; quota_limit (null = unlimited) caps consumption over quota_period. version is OCC.
export interface AiEntitlementsTable {
  organization_id: string
  id: Generated<string>
  resource_kind: string
  resource_key: string
  allowed: Generated<boolean>
  quota_limit: NullableNumericColumn
  quota_period: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// Consumption counters. period_key names the window ('2026-07' / '2026-07-18' / 'all'). used accumulates;
// consume increments it atomically under a FOR UPDATE row lock so concurrent consumes cannot overspend.
export interface AiQuotaUsageTable {
  organization_id: string
  id: Generated<string>
  resource_kind: string
  resource_key: string
  period_key: string
  used: NumericColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// APPEND-ONLY eval log. subject_id is the OPAQUE id of what was evaluated (no FK). No update/delete.
export interface AiEvaluationsTable {
  organization_id: string
  id: Generated<string>
  subject_id: string | null
  model_key: string
  metric: string
  score: NumericColumn
  verdict: string
  notes: string | null
  evaluated_by: string | null
  created_at: TimestampColumn
}

// APPEND-ONLY prompt-injection / safety guard log (evidence). subject_id is OPAQUE (no FK). No update.
export interface AiGuardEventsTable {
  organization_id: string
  id: Generated<string>
  subject_id: string | null
  guard_kind: string
  action: string
  detail: string
  detected_by: string
  created_at: TimestampColumn
}

// === R6 s3 service ticket + SLA tables (20260821090001) ===
// account_id / reporter_contact_id / project_id / contract_id / agent_session_id / remote_session_id
// are OPAQUE cross-schema links (no FK). sla_policy_id is a same-schema nullable ref. version is OCC.
export interface ServiceSlaPoliciesTable {
  organization_id: string
  id: Generated<string>
  name: string
  targets: JsonbColumn
  is_default: Generated<boolean>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface ServiceTicketsTable {
  organization_id: string
  id: Generated<string>
  account_id: string
  reporter_contact_id: string | null
  subject: string
  body: Generated<string>
  status: Generated<string>
  priority: Generated<string>
  assignee_user_id: string | null
  project_id: string | null
  contract_id: string | null
  agent_session_id: string | null
  remote_session_id: string | null
  sla_policy_id: string | null
  first_response_due_at: NullableTimestampColumn
  resolution_due_at: NullableTimestampColumn
  first_responded_at: NullableTimestampColumn
  resolved_at: NullableTimestampColumn
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// Append-only public-reply / internal-memo split (INSERT + SELECT only). visibility carries the
// delivery/crm scope vocabulary so a customer-scoped read filters on it exactly like comments.
export interface ServiceTicketRepliesTable {
  organization_id: string
  id: Generated<string>
  ticket_id: string
  kind: string
  visibility: string
  author_user_id: string
  body: string
  created_at: TimestampColumn
}

// Append-only 검수 evidence (INSERT + SELECT only). deliverable_ref is an opaque artifact link.
export interface RequirementAcceptancesTable {
  organization_id: string
  id: Generated<string>
  requirement_id: string
  result: string
  accepted_by: string
  accepted_at: TimestampColumn
  notes: string | null
  deliverable_ref: string | null
  revision: Generated<number>
  created_at: TimestampColumn
}

// === R6 s4 planning tables (20260822090001) ===
// project_id / work_item_id / wbs_node_id are OPAQUE cross-schema links (no FK); parent_id is the
// in-schema tree self-FK (composite). version is the OCC counter.
export interface WbsNodesTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  parent_id: string | null
  wbs_code: string
  name: string
  node_type: Generated<string>
  sort_order: Generated<number>
  planned_start: NullableDateColumn
  planned_end: NullableDateColumn
  planned_effort_hours: NullableNumericColumn
  work_item_id: string | null
  status: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

export interface MilestonesTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  wbs_node_id: string | null
  name: string
  target_date: string
  status: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// Append-only baseline header + immutable per-node snapshot rows (INSERT + SELECT only in app code).
export interface ScheduleBaselinesTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  name: string
  captured_by: string | null
  entry_count: Generated<number>
  captured_at: TimestampColumn
  created_at: TimestampColumn
}

export interface BaselineEntriesTable {
  organization_id: string
  id: Generated<string>
  baseline_id: string
  wbs_node_id: string
  parent_id: string | null
  wbs_code: string
  name: string
  node_type: string
  sort_order: Generated<number>
  planned_start: NullableDateColumn
  planned_end: NullableDateColumn
  planned_effort_hours: NullableNumericColumn
  created_at: TimestampColumn
}

// === R6 s5 planning resource allocation + effort tables (20260823090001) ===
// project_id / wbs_node_id / work_item_id / user_id are OPAQUE cross-schema links (no FK). Over-
// allocation is intentionally unrestricted at write; the utilization read surfaces it. version is
// the OCC counter for :update.
export interface ResourceAssignmentsTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  wbs_node_id: string | null
  user_id: string
  allocation_pct: NumericColumn
  start_date: string
  end_date: string
  planned_effort_hours: NullableNumericColumn
  role_label: string | null
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// Append-only ACTUAL effort log (INSERT + SELECT only in app code); a correction is a new row.
export interface EffortEntriesTable {
  organization_id: string
  id: Generated<string>
  project_id: string
  wbs_node_id: string | null
  work_item_id: string | null
  user_id: string
  entry_date: string
  effort_hours: NumericColumn
  note: string | null
  created_at: TimestampColumn
}

// R6 slice 6: one row per external import invocation (audit + result record).
export interface ImportRunsTable {
  organization_id: string
  id: Generated<string>
  source: string
  dry_run: boolean
  status: string
  created_count: Generated<number>
  updated_count: Generated<number>
  skipped_count: Generated<number>
  actor_user_id: string | null
  created_at: TimestampColumn
}

// The dedup table: (external_system, external_key, resource_type) is the idempotency key; resource_id
// is an OPAQUE pointer into delivery (no cross-schema FK).
export interface ImportExternalLinksTable {
  organization_id: string
  id: Generated<string>
  external_system: string
  external_key: string
  resource_type: string
  resource_id: string
  import_run_id: string
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

// Schema-qualified keys — Kysely resolves these to `schema.table` in SQL.
export interface Database {
  'identity.organizations': OrganizationsTable
  'identity.user_accounts': UserAccountsTable
  'identity.memberships': MembershipsTable
  'identity.invitations': InvitationsTable
  'identity.device_sessions': DeviceSessionsTable
  'identity.roles': RolesTable
  'identity.permissions': PermissionsTable
  'identity.role_permissions': RolePermissionsTable
  'identity.role_manifest_seed': RoleManifestSeedTable
  'identity.entitlement_plans': EntitlementPlansTable
  'identity.plan_entitlements': PlanEntitlementsTable
  'identity.entitlement_manifest_seed': EntitlementManifestSeedTable
  'identity.subscriptions': SubscriptionsTable
  'identity.usage_meters': UsageMetersTable
  'identity.resource_grants': ResourceGrantsTable
  'operations.outbox_events': OutboxEventsTable
  'operations.dead_letter_events': DeadLetterEventsTable
  'operations.idempotency_records': IdempotencyRecordsTable
  'operations.stream_cursors': StreamCursorsTable
  'operations.operations': OperationsTable
  'operations.artifact_upload_sessions': ArtifactUploadSessionsTable
  'audit.audit_events': AuditEventsTable
  'audit.authorization_denials': AuthorizationDenialsTable
  'delivery.teams': TeamsTable
  'delivery.team_counters': TeamCountersTable
  'delivery.workflow_states': WorkflowStatesTable
  'delivery.work_items': WorkItemsTable
  'delivery.comments': CommentsTable
  'delivery.projects': ProjectsTable
  'delivery.project_teams': ProjectTeamsTable
  'collaboration.channels': ChannelsTable
  'collaboration.channel_members': ChannelMembersTable
  'collaboration.messages': MessagesTable
  'collaboration.message_revisions': MessageRevisionsTable
  'collaboration.message_reactions': MessageReactionsTable
  'collaboration.read_cursors': ReadCursorsTable
  'collaboration.message_mentions': MessageMentionsTable
  'collaboration.message_attachments': MessageAttachmentsTable
  'collaboration.notifications': NotificationsTable
  'collaboration.channel_mutes': ChannelMutesTable
  'collaboration.notification_preferences': NotificationPreferencesTable
  'collaboration.channel_notification_preferences': ChannelNotificationPreferencesTable
  'collaboration.message_pins': MessagePinsTable
  'collaboration.message_work_item_links': MessageWorkItemLinksTable
  'agent.objects': ObjectsTable
  'agent.artifacts': ArtifactsTable
  'agent.artifact_revisions': ArtifactRevisionsTable
  'support.remote_sessions': RemoteSessionsTable
  'support.remote_session_participants': RemoteSessionParticipantsTable
  'support.remote_session_consents': RemoteSessionConsentsTable
  'support.remote_session_capabilities': RemoteSessionCapabilitiesTable
  'support.remote_session_driver_grants': RemoteSessionDriverGrantsTable
  'support.remote_session_audit': RemoteSessionAuditTable
  'execution.agent_sessions': AgentSessionsTable
  'execution.agent_events': AgentEventsTable
  'execution.agent_turns': AgentTurnsTable
  'execution.agent_provenance': AgentProvenanceTable
  'execution.agent_session_intake': AgentSessionIntakeTable
  'execution.agent_capture_gaps': AgentCaptureGapsTable
  'execution.agent_event_quarantine': AgentEventQuarantineTable
  'execution.installation_public_keys': InstallationPublicKeysTable
  'execution.batch_submission_nonces': BatchSubmissionNoncesTable
  'crm.accounts': CrmAccountsTable
  'crm.account_sites': CrmAccountSitesTable
  'crm.account_contacts': CrmAccountContactsTable
  'crm.opportunities': CrmOpportunitiesTable
  'crm.contracts': CrmContractsTable
  'crm.contract_scope_items': CrmContractScopeItemsTable
  'crm.change_orders': CrmChangeOrdersTable
  'crm.change_order_scope_items': CrmChangeOrderScopeItemsTable
  'crm.contract_projects': CrmContractProjectsTable
  'change.change_requests': ChangeRequestsTable
  'service.sla_policies': ServiceSlaPoliciesTable
  'service.tickets': ServiceTicketsTable
  'service.ticket_replies': ServiceTicketRepliesTable
  'requirements.requirements': RequirementsTable
  'requirements.requirement_work_items': RequirementWorkItemsTable
  'requirements.requirement_acceptances': RequirementAcceptancesTable
  'qa.deliverables': DeliverablesTable
  'qa.test_cases': TestCasesTable
  'qa.defects': DefectsTable
  'governance.project_risks': ProjectRisksTable
  'governance.project_decisions': ProjectDecisionsTable
  'governance.status_reports': StatusReportsTable
  'knowledge.articles': KnowledgeArticlesTable
  'planning.wbs_nodes': WbsNodesTable
  'planning.milestones': MilestonesTable
  'planning.schedule_baselines': ScheduleBaselinesTable
  'planning.baseline_entries': BaselineEntriesTable
  'planning.resource_assignments': ResourceAssignmentsTable
  'planning.effort_entries': EffortEntriesTable
  'imports.import_runs': ImportRunsTable
  'imports.import_external_links': ImportExternalLinksTable
  'automation.runbooks': AutomationRunbooksTable
  'automation.runbook_executions': RunbookExecutionsTable
  'automation.work_queue_items': WorkQueueItemsTable
  'ai.entitlements': AiEntitlementsTable
  'ai.quota_usage': AiQuotaUsageTable
  'ai.evaluations': AiEvaluationsTable
  'ai.guard_events': AiGuardEventsTable
  'meetings.meetings': MeetingsTable
  'meetings.calendar_links': MeetingCalendarLinksTable
  'meetings.guest_links': MeetingGuestLinksTable
  'meetings.guest_sessions': MeetingGuestSessionsTable
  'meetings.participants': MeetingParticipantsTable
  'meetings.media_events': MeetingMediaEventsTable
  'meetings.recordings': MeetingRecordingsTable
  'meetings.governance': MeetingGovernanceTable
  'meetings.capture_consents': MeetingCaptureConsentsTable
  'meetings.processing_jobs': MeetingProcessingJobsTable
  'meetings.transcripts': MeetingTranscriptsTable
  'meetings.transcript_segments': MeetingTranscriptSegmentsTable
  'meetings.transcript_segment_revisions': MeetingTranscriptSegmentRevisionsTable
  'meetings.decisions': MeetingDecisionsTable
  'meetings.action_items': MeetingActionItemsTable
  'meetings.minutes': MeetingMinutesTable
  'meetings.minute_revisions': MeetingMinuteRevisionsTable
  'meetings.agenda_items': MeetingAgendaItemsTable
  'assets.assets': AssetsTable
  'assets.asset_links': AssetLinksTable
  'assets.asset_events': AssetEventsTable
  'finance.invoices': FinanceInvoicesTable
  'finance.invoice_line_items': FinanceInvoiceLineItemsTable
  'finance.payments': FinancePaymentsTable
}
