-- R8 slice: ASSET REGISTRY / CMDB — a per-customer/project asset registry with lifecycle, assignment,
-- and links to service tickets (doc 14 §R8 "서비스 데스크·원격지원·자산" — the asset piece). A running
-- org keeps a registry of assets (hardware/software/license/service), each optionally scoped to a
-- customer account and/or project and optionally assigned to a user; a CMDB relationship graph links an
-- asset to tickets / work items / other assets; and an append-only event log records every lifecycle
-- mutation. Dedicated `assets` schema so every reference to crm.accounts, delivery.projects, and
-- service.tickets is a genuine OPAQUE cross-schema id — no cross-schema FK, same-tenant integrity via
-- the shared organization_id (mirrors crm.contract_projects / governance.*).
create schema if not exists assets;
grant usage on schema assets to pie_app;
grant usage on schema assets to pie_worker;

-- assets.assets: a registry entry. account_id / project_id / assigned_to_user_id are OPAQUE links (no
-- FK). status walks active → in_repair → active|retired|lost (a status change is the OCC :transition;
-- assignment is an OCC update). version is the OCC counter.
create table assets.assets (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  asset_type text not null default 'hardware',
  status text not null default 'active',
  account_id uuid,
  project_id uuid,
  assigned_to_user_id uuid,
  identifier text,
  vendor text,
  purchase_date date,
  warranty_end date,
  notes text,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint assets_asset_type_check
    check (asset_type in ('hardware', 'software', 'license', 'service', 'other')),
  constraint assets_status_check
    check (status in ('active', 'in_repair', 'retired', 'lost'))
);

create index assets_account_idx on assets.assets (organization_id, account_id, id);
create index assets_project_idx on assets.assets (organization_id, project_id, id);
create index assets_assigned_idx on assets.assets (organization_id, assigned_to_user_id, id);
create index assets_status_idx on assets.assets (organization_id, status, id);

-- assets.asset_links: the CMDB relationship graph. asset_id / linked_id are OPAQUE ids (no FK) so a
-- link to a service ticket or another asset never cascades. The UNIQUE key makes a duplicate edge a
-- constraint error (idempotent CMDB graph). version present for wire uniformity.
create table assets.asset_links (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  asset_id uuid not null,
  linked_kind text not null,
  linked_id uuid not null,
  relation text not null default 'related',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint asset_links_linked_kind_check
    check (linked_kind in ('ticket', 'work_item', 'asset')),
  constraint asset_links_relation_check
    check (relation in ('used_by', 'depends_on', 'affected_by', 'related')),
  constraint asset_links_unique
    unique (organization_id, asset_id, linked_kind, linked_id, relation)
);

create index asset_links_asset_idx on assets.asset_links (organization_id, asset_id, id);

-- assets.asset_events: the append-only lifecycle log — every asset mutation writes exactly one row so
-- the asset history is a faithful audit trail (never updated in place, so no version/OCC). asset_id /
-- actor_user_id are OPAQUE ids (no FK). detail is opaque jsonb (e.g. {from,to} for a status change).
create table assets.asset_events (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  asset_id uuid not null,
  event_kind text not null,
  detail jsonb,
  actor_user_id uuid,
  occurred_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint asset_events_event_kind_check
    check (event_kind in (
      'created', 'assigned', 'unassigned', 'status_changed', 'moved', 'linked', 'unlinked'
    ))
);

create index asset_events_asset_idx on assets.asset_events (organization_id, asset_id, occurred_at, id);

-- === RLS: the standard tenant pair (permissive isolation + restrictive boundary guard + FORCE) ===
do $$
declare
  t text;
begin
  foreach t in array array['assets', 'asset_links', 'asset_events']
  loop
    execute format('alter table assets.%I enable row level security', t);
    execute format('alter table assets.%I force row level security', t);
    execute format(
      'create policy %I on assets.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on assets.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
    execute format('grant select, insert, update, delete on assets.%I to pie_app', t);
  end loop;
end
$$;
