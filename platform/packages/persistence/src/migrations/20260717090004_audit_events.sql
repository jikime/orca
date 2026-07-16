-- audit.audit_events: append-only tenant audit trail. Corrections are new rows
-- referencing the original, never UPDATE/DELETE (doc 30 :304) — enforced by
-- granting pie_app SELECT + INSERT only (no UPDATE/DELETE privilege).
create table audit.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references identity.organizations (id),
  actor_id text,
  action text not null,
  target_type text not null,
  target_id uuid,
  before_digest text,
  after_digest text,
  request_id text,
  trace_id text,
  occurred_at timestamptz not null default now()
);

create index audit_events_organization_id_idx on audit.audit_events (organization_id);

alter table audit.audit_events enable row level security;
alter table audit.audit_events force row level security;

create policy audit_tenant_isolation on audit.audit_events
  as permissive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

create policy audit_tenant_boundary_guard on audit.audit_events
  as restrictive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

-- Append-only for the app role: no UPDATE/DELETE grant. pie_worker gets nothing
-- here (it must not touch audit beyond what a future explicit grant allows).
grant select, insert on audit.audit_events to pie_app;
