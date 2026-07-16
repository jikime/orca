import type { ColumnType, Generated } from 'kysely'

// pg returns bigint (int8) as string; accept string/number/bigint on write.
type BigIntColumn = ColumnType<string, string | number | bigint, string | number | bigint>
type DefaultedBigIntColumn = ColumnType<
  string,
  string | number | bigint | undefined,
  string | number | bigint
>
type TimestampColumn = ColumnType<Date, Date | string | undefined, Date | string>
type NullableTimestampColumn = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>
// jsonb: read back as parsed JSON (unknown), written as a JSON string.
type JsonbColumn = ColumnType<unknown, string, string>

export interface OrganizationsTable {
  id: string
  slug: string
  display_name: string
  status: Generated<string>
  version: DefaultedBigIntColumn
  created_at: TimestampColumn
  updated_at: TimestampColumn
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

// Schema-qualified keys — Kysely resolves these to `schema.table` in SQL.
export interface Database {
  'identity.organizations': OrganizationsTable
  'operations.outbox_events': OutboxEventsTable
  'operations.idempotency_records': IdempotencyRecordsTable
  'audit.audit_events': AuditEventsTable
}
