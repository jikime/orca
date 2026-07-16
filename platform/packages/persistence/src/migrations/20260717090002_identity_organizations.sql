-- identity.organizations: the tenant root. Global table (no organization_id of
-- its own) — for RLS the tenant key is the row's own id. Columns mirror the wire
-- contract (contracts/schemas/resources/organization.v1) mapped camelCase ->
-- snake_case, plus an internal lifecycle status (doc 30 catalog).
create table identity.organizations (
  id uuid primary key,
  slug text not null,
  display_name text not null,
  status text not null default 'active',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_slug_key unique (slug),
  constraint organizations_status_check check (status in ('active', 'suspended', 'archived'))
);

alter table identity.organizations enable row level security;
-- FORCE so even the table owner is subject to policy; app role is NOBYPASSRLS.
alter table identity.organizations force row level security;

-- A tenant sees only its own organization row: the discriminator here is id, not
-- organization_id, because organizations is the tenant root. Missing context ->
-- current_setting returns '' -> nullif -> NULL -> matches nothing (default deny).
create policy organizations_tenant_isolation on identity.organizations
  as permissive
  for all
  to pie_app
  using (id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (id = nullif(current_setting('pie.organization_id', true), '')::uuid);

-- Restrictive guard keeps the tenant boundary even if a future permissive policy
-- is added; restrictive policies AND with permissive ones.
create policy organizations_tenant_boundary_guard on identity.organizations
  as restrictive
  for all
  to pie_app
  using (id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (id = nullif(current_setting('pie.organization_id', true), '')::uuid);

grant select, insert, update on identity.organizations to pie_app;
