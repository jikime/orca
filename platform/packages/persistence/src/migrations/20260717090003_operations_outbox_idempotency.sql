-- operations.outbox_events: transactional outbox. Columns are EXACTLY doc 30
-- :330-332 so the DB -> outbox -> Worker -> Realtime flow (slice 2) has a stable
-- envelope. payload is jsonb (provider-neutral event body).
create table operations.outbox_events (
  id uuid primary key,
  organization_id uuid not null references identity.organizations (id),
  aggregate_type text not null,
  aggregate_id uuid not null,
  aggregate_version bigint not null,
  event_type text not null,
  event_schema_version integer not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  claimed_by text,
  claim_expires_at timestamptz,
  attempt_count integer not null default 0,
  published_at timestamptz,
  last_error_code text
);

-- Partial claim index over queue state only (doc 30 :337-341): the Worker's
-- FOR UPDATE SKIP LOCKED claim (slice 2) scans just unpublished rows in order.
create index outbox_pending_claim_idx
  on operations.outbox_events (available_at, id)
  where published_at is null;

-- FK referencing column index for tenant-scoped reads and delete checks (doc :137).
create index outbox_events_organization_id_idx on operations.outbox_events (organization_id);

alter table operations.outbox_events enable row level security;
alter table operations.outbox_events force row level security;

create policy outbox_tenant_isolation on operations.outbox_events
  as permissive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

create policy outbox_tenant_boundary_guard on operations.outbox_events
  as restrictive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

-- The Worker claims across tenants via a dedicated role-scoped grant + policy
-- (doc 30 :208-209), NOT BYPASSRLS. It re-enters each org's context for the
-- actual side effects (slice 2). This policy is scoped to pie_worker only.
create policy outbox_worker_claim on operations.outbox_events
  as permissive
  for all
  to pie_worker
  using (true)
  with check (true);

grant select, insert, update on operations.outbox_events to pie_app;
grant select, update on operations.outbox_events to pie_worker;

-- operations.idempotency_records: one row per (principal, org, method, route,
-- key). A replay with the same key but a different payload hash is rejected;
-- the lease + status + response reference let the API replay a stored result.
create table operations.idempotency_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references identity.organizations (id),
  principal_id text not null,
  request_method text not null,
  request_route text not null,
  idempotency_key text not null,
  payload_hash text not null,
  status text not null default 'in_progress',
  response_ref text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint idempotency_records_status_check check (status in ('in_progress', 'completed')),
  constraint idempotency_records_scope_key
    unique (principal_id, organization_id, request_method, request_route, idempotency_key)
);

create index idempotency_records_organization_id_idx
  on operations.idempotency_records (organization_id);

alter table operations.idempotency_records enable row level security;
alter table operations.idempotency_records force row level security;

create policy idempotency_tenant_isolation on operations.idempotency_records
  as permissive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

create policy idempotency_tenant_boundary_guard on operations.idempotency_records
  as restrictive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

grant select, insert, update on operations.idempotency_records to pie_app;
