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
  version: DefaultedBigIntColumn
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
  created_at: TimestampColumn
  updated_at: TimestampColumn
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
  'collaboration.message_reactions': MessageReactionsTable
  'collaboration.read_cursors': ReadCursorsTable
  'collaboration.message_mentions': MessageMentionsTable
  'collaboration.message_attachments': MessageAttachmentsTable
  'collaboration.notifications': NotificationsTable
  'agent.objects': ObjectsTable
  'agent.artifacts': ArtifactsTable
  'agent.artifact_revisions': ArtifactRevisionsTable
}
