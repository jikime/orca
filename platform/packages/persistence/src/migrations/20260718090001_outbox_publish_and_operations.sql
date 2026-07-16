-- Slice 2 expand migration: per-stream publish sequence, a per-org cursor
-- counter, a dead-letter park marker, and the operations record. Additive only
-- (expand step) — earlier migrations stay frozen.

-- The Worker assigns a per-org monotonic sequence at publish time and records it
-- here; the Realtime cursor and the /changes feed are ordered by it. Parked rows
-- (poison messages past the retry budget) never get a sequence.
alter table operations.outbox_events
  add column stream_sequence bigint,
  add column parked_at timestamptz;

-- Ordered change feed + realtime catch-up: published rows per org by sequence.
create index outbox_changes_feed_idx
  on operations.outbox_events (organization_id, stream_sequence)
  where published_at is not null;

-- Per-org publish counter. Written only by the Worker at publish (dedicated
-- grant, cross-tenant like the outbox claim — not BYPASSRLS). The increment and
-- the row's published_at commit in ONE transaction, so a rollback leaves no gap.
create table operations.stream_cursors (
  organization_id uuid primary key references identity.organizations (id),
  last_sequence bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table operations.stream_cursors enable row level security;
alter table operations.stream_cursors force row level security;

create policy stream_cursors_worker on operations.stream_cursors
  as permissive
  for all
  to pie_worker
  using (true)
  with check (true);

grant select, insert, update on operations.stream_cursors to pie_worker;

-- operations.operations: async command status (doc 30 :298). The domain mutation
-- records one so getOperation has an honest resource to return.
create table operations.operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references identity.organizations (id),
  kind text not null,
  status text not null default 'pending',
  result_resource_id uuid,
  problem jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operations_status_check
    check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled'))
);

create index operations_organization_id_idx on operations.operations (organization_id);

alter table operations.operations enable row level security;
alter table operations.operations force row level security;

create policy operations_tenant_isolation on operations.operations
  as permissive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

create policy operations_tenant_boundary_guard on operations.operations
  as restrictive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

grant select, insert, update on operations.operations to pie_app;
