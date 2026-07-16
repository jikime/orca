-- Slice 6 migration: dead-letter store for the transactional outbox queue.
-- doc 14 R2 범위 "transactional outbox, 작업 큐, 멱등 소비자, dead-letter". doc 30
-- lists no dedicated dead-letter table, so this is the honest minimum: a parked
-- outbox row relocates here (out of the hot queue), keeping the pending-claim
-- partial index small and dead letters operationally visible.

-- The Worker deletes a parked row from the hot outbox when it dead-letters it,
-- so its dedicated grant needs DELETE in addition to the claim's SELECT/UPDATE.
grant delete on operations.outbox_events to pie_worker;

-- One row per dead-lettered event. Columns mirror the outbox envelope
-- (operations.outbox_events) so a requeue can rebuild the queue row exactly, plus
-- the park facts and a requeue audit trail. status keeps a requeued tombstone
-- rather than deleting, so the trail survives.
create table operations.dead_letter_events (
  id uuid primary key,
  organization_id uuid not null references identity.organizations (id),
  aggregate_type text not null,
  aggregate_id uuid not null,
  aggregate_version bigint not null,
  event_type text not null,
  event_schema_version integer not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  attempt_count integer not null,
  last_error_code text,
  parked_at timestamptz not null default now(),
  status text not null default 'parked',
  requeue_count integer not null default 0,
  requeued_at timestamptz,
  requeued_by text,
  constraint dead_letter_status_check check (status in ('parked', 'requeued'))
);

-- FK/tenant read index; active dead letters filtered by the parked status.
create index dead_letter_events_organization_id_idx
  on operations.dead_letter_events (organization_id);
create index dead_letter_events_parked_idx
  on operations.dead_letter_events (organization_id, parked_at)
  where status = 'parked';

alter table operations.dead_letter_events enable row level security;
alter table operations.dead_letter_events force row level security;

-- pie_app sees only its own org's dead letters (a future in-tenant ops view),
-- via the same permissive + restrictive tenant pair every operations table uses.
create policy dead_letter_tenant_isolation on operations.dead_letter_events
  as permissive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

create policy dead_letter_tenant_boundary_guard on operations.dead_letter_events
  as restrictive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

-- The Worker relocates parked rows across tenants via its role-scoped grant +
-- policy (doc 30 :208-209), NOT BYPASSRLS — mirrors the outbox claim policy.
create policy dead_letter_worker on operations.dead_letter_events
  as permissive
  for all
  to pie_worker
  using (true)
  with check (true);

grant select on operations.dead_letter_events to pie_app;
grant select, insert, update on operations.dead_letter_events to pie_worker;
