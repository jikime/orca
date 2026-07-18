-- R6 slice 6: external IMPORT (Jira/Redmine/CSV) with dry-run + IDEMPOTENT re-import — closes
-- R6's last exit condition (doc 14 §R6 ~870/~877: "기존 Jira·Redmine·CSV import dry-run" and
-- "import 재실행이 프로젝트·사용자·작업을 중복 생성하지 않는다"). The connector normalizes each
-- source upstream; this schema accepts source-agnostic normalized rows and maps them onto the
-- EXISTING delivery.projects / delivery.work_items tables (never modified here) via an opaque,
-- no-cross-schema-FK link. Same tenant model as the rest of the platform: composite
-- (organization_id, id) keys + the permissive tenant_isolation + restrictive tenant_boundary_guard
-- + FORCE RLS pair keyed on pie.organization_id.
create schema if not exists imports;
grant usage on schema imports to pie_app;
grant usage on schema imports to pie_worker;

-- imports.import_runs: one row per import invocation — an audit + result record. dry_run runs write
-- a status='planned' row (the computed plan) and NO delivery resource / link; a real run writes
-- status='applied' with the create/update/skip counts. actor_user_id is the OPAQUE caller (no FK,
-- mirroring audit rows).
create table imports.import_runs (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  source text not null,
  dry_run boolean not null,
  status text not null,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  actor_user_id uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint import_runs_source_check check (source in ('jira', 'redmine', 'csv')),
  constraint import_runs_status_check check (status in ('planned', 'applied', 'failed')),
  constraint import_runs_counts_check
    check (created_count >= 0 and updated_count >= 0 and skipped_count >= 0)
);

create index import_runs_org_idx on imports.import_runs (organization_id, created_at);

-- imports.import_external_links: THE dedup table that makes re-import idempotent. The external
-- identity — (external_system, external_key, resource_type) — is the dedup key, NOT a request
-- Idempotency-Key: a second import of the same external_key finds this link and UPDATEs the linked
-- resource instead of inserting a new one. resource_id is an OPAQUE cross-schema pointer into
-- delivery (project / work_item) — deliberately NO foreign key, mirroring the opaque links in
-- planning/crm, so a delivery-side delete never breaks the mapping row.
create table imports.import_external_links (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  external_system text not null,
  external_key text not null,
  resource_type text not null,
  resource_id uuid not null,
  import_run_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint import_external_links_resource_type_check
    check (resource_type in ('project', 'work_item', 'requirement')),
  -- The idempotency key: one internal resource per (system, key, type) per org.
  constraint import_external_links_dedup_unique
    unique (organization_id, external_system, external_key, resource_type),
  constraint import_external_links_run_fk
    foreign key (organization_id, import_run_id) references imports.import_runs (organization_id, id)
    on delete cascade
);

create index import_external_links_run_idx
  on imports.import_external_links (organization_id, import_run_id);

-- === RLS: the standard tenant pair on both new imports tables ===
do $$
declare
  t text;
begin
  foreach t in array array['import_runs', 'import_external_links']
  loop
    execute format('alter table imports.%I enable row level security', t);
    execute format('alter table imports.%I force row level security', t);
    execute format(
      'create policy %I on imports.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on imports.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
    execute format('grant select, insert, update, delete on imports.%I to pie_app', t);
  end loop;
end
$$;
